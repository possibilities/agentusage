# Conformance corpus schema

`tests/fixtures/corpus/` is the language-neutral, versioned contract that BOTH
runtimes replay against: the Python scrape CLI today, and the Bun port as it
lands. Each subdirectory is one scenario case. The corpus IS the contract —
treat a change to any committed case as a contract change.

## Case layout

```
tests/fixtures/corpus/<scenario>/
  case.json         # metadata: target, argv, pinned clock, geometry, expectations
  transcript.ansi   # raw ANSI bytes the fake TUI replays (post alt-screen entry)
  screen.txt        # frozen pyte-rendered screen the parsers consume (see below)
  expected.json     # the discriminated-contract JSON the CLI must print on stdout
```

### `screen.txt`

The pyte-rendered panel text a driver hands the parser — newline-joined,
per-row-rstripped display — frozen so the corpus contract survives Python's
deletion. It is exactly `scrape.scrape`'s screen construction (alt-screen enter
byte prepended to `transcript.ansi`, fed through pyte at the case geometry),
plus a single trailing newline that every reader strips back. Two custody
artifacts consume it WITHOUT a subprocess or tmux: the in-process parse
conformance (`src/parse-conformance.test.ts`, plain `bun test`) and the golden
regenerator (`tests/generate.ts`). The end-to-end runner does NOT read it — it
re-renders live through tmux (see "Conformance layers").

### `case.json`

| field                | meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `schema_version`     | corpus case schema (currently `1`)                                  |
| `description`        | one-line human summary of the scenario                              |
| `target`             | `claude` or `codex`                                                 |
| `argv`               | CLI argv WITHOUT `--command` (the harness appends the fake TUI)     |
| `now`                | pinned wall clock, offset-bearing ISO — the clock reset times resolve against |
| `tz`                 | pinned `TZ` env the harness must export (see "Time" below)          |
| `cols`, `rows`       | pinned PTY geometry (mirrors any `--rows`/`--cols` in `argv`)       |
| `paint_on_boot`      | `true` when the panel paints pre-send (OAuth sign-in classified before the slash) |
| `mount_delay_ms`     | fake TUI mount delay before it becomes input-ready                  |
| `logged_in`          | the `loggedIn` the fake's `auth status` mode returns (the CLI's no-bar probe) |
| `expected_exit_code` | process exit code: `0` for every ok arm, `1` for the error arm      |

### `transcript.ansi`

The raw bytes the fake TUI writes to stdout AFTER it enters the alternate screen
(`\x1b[?1049h`, emitted by the fake on boot, not stored here). Row breaks are
`\r\n` so pyte / a VT emulator returns each line to column 0. Two cases are
structurally synthetic rather than lifted from a captured panel:

- `claude-wrap-split-signed-out` — at `cols=30` the OAuth authorize URL wraps
  mid-token, so `/oauth/authorize` sits on no single row yet the dewrapped
  screen reconstructs it. Carries no secret, so scrubbing cannot shift the seam.
- `claude-spinner-snapshot-stable` — a spinner animates on a scratch row and is
  then cleared, so the byte stream stays busy while the rendered snapshot equals
  the plain subscribed panel (exercises the snapshot-idle mapping).

## Expected outputs are GENERATED, never hand-written

Every `expected.json` is DERIVED by feeding a rendered screen through the real
parser + CLI arm-branching under the pinned `now` — hand-writing one would encode
a guess instead of the contract. Two generators derive byte-identical goldens:

- **`tests/fixtures/corpus/generate.py`** (Python) — the canonical generator that
  also freezes `transcript.ansi`, `screen.txt`, and `case.json`. Renders each
  transcript through pyte (`scrape.scrape`'s construction) and reproduces
  `agentusage.scrape_cli`'s `run()` branching.
- **`tests/generate.ts`** (Bun) — re-derives every `expected.json` FROM the frozen
  `screen.txt` via the TS parsers, so the goldens stay reproducible after Python
  is deleted. It reproduces Python's `json.dumps(indent=2, ensure_ascii=False)`
  byte-for-byte (including claude's `NN.0` float percents vs codex's integer
  percents), so its output is byte-identical to the checked-in goldens.

```
uv run python tests/fixtures/corpus/generate.py   # freeze screens + regen goldens
bun tests/generate.ts                             # regen goldens from frozen screens
bun tests/generate.ts --check                     # prove byte-identity, write nothing
```

### Provenance of the frozen screens

`screen.txt` is the normative render, so its origin is recorded for
reconstructibility. The committed screens were frozen by

```
uv run python tests/fixtures/corpus/generate.py
```

descending from the pyte render path validated green by the python-vs-bun parity
gate (`tests/test_bun_parity.py`, `tests/test_dual_run_cli.py`) at branch commit
`2a5b7d7` — the freeze precondition (a stale render would bake a wrong contract).
While the Python runtime lives (this epic), re-running that invocation
reproduces the screens byte-identically; a run that changes any golden signals
render drift and must be reconciled against the parity gate before committing.

### Adding a genuinely new scenario

A parser cannot invent a screen, so a new case needs its `screen.txt` frozen from
a real render first: add the scenario to `generate.py` (which renders the
transcript through pyte) and run it while Python lives, or capture the rendered
pane via the tmux driver. THEN `bun tests/generate.ts` derives the new
`expected.json`. Never hand-author `screen.txt` or `expected.json`.

## Conformance layers

The corpus is verified at two altitudes, both green on a designated box:

- **In-process parse conformance** — `src/parse-conformance.test.ts`, plain
  `bun test`. Feeds each frozen `screen.txt` through the parsers + arm-branching
  and deep-compares `expected.json`. Tmux-free and subprocess-free (so it dodges
  Bun#24690's empty subprocess pipes under the test runner).
- **End-to-end runner** — `bun run conformance` (`scripts/conformance.ts`), a
  standalone `bun run` script (NOT `bun test`). Drives the real bun CLI through
  the fake TUI for every corpus case plus the CLI-level forks (auth probe,
  mount-delay race, stubborn-child reaping) and the subprocess contract cases
  (writes-no-state, argv-error exits), capturing stdout via temp files. A
  tmux-absent host reports reasoned skips; `AGENTUSAGE_REQUIRE_CONFORMANCE=1`
  promotes every skip to a failure (the successor to `REQUIRE_PARITY`).

### Time

Claude reset times resolve in the SYSTEM-LOCAL zone (`datetime.astimezone()`),
so the generator pins `TZ` to each case's `tz` before generating, and a replay
harness MUST export the same `TZ`. Codex keeps `now`'s own fixed offset, so its
reset times are `TZ`-independent. The CLI threads an injectable clock via the
`AGENTUSAGE_NOW` env seam (offset-bearing ISO), so replaying a case with
`AGENTUSAGE_NOW=<case.now>` reproduces the reset-bearing `expected.json`
end-to-end — the same pinned `now` the generator resolves at the parser level.
`test_dual_run_cli.py` exercises exactly this against both runtimes.

## Replaying a case (how a harness drives it)

1. Export `TZ=<case.tz>`, `AGENTUSAGE_NOW=<case.now>`, and
   `AGENTUSAGE_FAKE_CASE=<absolute case dir>`.
2. Invoke the CLI with `case.argv` plus `--command <path to tests/fake-tui.ts>`.
3. The fake enters the alt screen, then either paints immediately
   (`paint_on_boot`) or waits for the scraper's ctrl-U + `/slash` + CR before
   replaying `transcript.ansi`. Its `auth status` mode answers `logged_in`.
4. Compare stdout to `expected.json` (semantic deep-equality, exact ISO strings,
   exactly one line with a trailing newline) and the exit code to
   `expected_exit_code`.

## Scenario inventory

| case                             | arm             | exit |
| -------------------------------- | --------------- | ---- |
| `claude-subscribed`              | ok / subscribed | 0    |
| `claude-subscribed-sonnet`       | ok / subscribed | 0    |
| `claude-depleted-week`           | ok / subscribed | 0    |
| `claude-no-subscription`         | ok / no_subscription | 0 |
| `claude-api-billing`             | ok / no_subscription | 0 |
| `claude-endpoint-rate-limited`   | error / upstream_limited | 1 |
| `claude-signed-out`              | ok / signed_out | 0    |
| `claude-wrap-split-signed-out`   | ok / signed_out | 0    |
| `claude-panel-missing`           | error / panel_missing | 1 |
| `claude-format-drift`            | error / format_changed | 1 |
| `claude-spinner-snapshot-stable` | ok / subscribed | 0    |
| `codex-ok`                       | ok / subscribed | 0    |
| `codex-ok-spark`                 | ok / subscribed | 0    |
| `codex-weekly-drift`             | ok / subscribed | 0    |

## Operator runbook: the bun soak (`scripts/soak-report.ts`)

This is a separate concern from the corpus above — the corpus is offline
conformance; this runbook is for the LIVE operator phase after the epic lands,
which flips one real profile's runtime and watches it soak. Recorded here (the
epic's other doc space) rather than in a new file, per the epic's docs-gaps
note.

**Flip.** Per-profile, set `usage_scraper_runtime: bun` as a config override in
keeper (env or config — env wins). The shipped default stays `uv` everywhere;
an invalid override value fails closed to `uv`. Nothing else changes: the
daemon boot gate needs no edit, and every other profile keeps scraping via
`uv run … agentusage.scrape_cli` untouched.

**Rollback.** Clear the override. The next cycle resumes `uv` for that profile
with zero code changes — the override is the entire blast radius.

**Requirements before trusting a soak verdict:**

- Run the flipped profile through the **LaunchAgent**, not an ad-hoc shell —
  `launchd`'s stripped env and its own process lifecycle are what the flip has
  to survive in practice.
- The soak window must span **at least one real sleep/wake** — the tmux
  scrape driver's server is ephemeral across sleep/wake (create-if-absent
  per scrape already handles it), and that's exactly the transition a shell
  session never exercises.
- **Privacy:** only turn on `StandardOutPath`/`StandardErrorPath` redirection
  for the duration of the soak window, then turn it back off. The scrape
  util's stdout is the usage JSON contract, which is account-identifying —
  it must not sit logged indefinitely.

**Reading the evidence.** Run the report read-only against the live state dir
(never write, never scrape):

```sh
bun scripts/soak-report.ts --since 48h --baseline 7d
```

`--since` is the soak window (default trailing 24h; a duration like `48h`/`7d`
or an absolute ISO instant — e.g. the flip timestamp). `--baseline` is a
second window of that duration immediately BEFORE `--since` starts — the
trailing `uv` history for the same profile(s), compared without ever
double-scraping the rate-limited `/usage` panel live. Add `--profile <id>` to
scope to the flipped profile(s), `--json` for a machine-readable form.

The report's `latency` figures are a **schedule-drift proxy**, not a raw
per-attempt duration (the runtime logs no such field): how much later than its
own prior `next_fetch_at` each attempt actually fired, bucketed against the
60s scrape wall-clock budget. `budgetTimeoutCount` (rendered as
`explicit-budget-timeouts`) is the direct, non-proxy signal — a `scrape_failed`
whose message names the SIGKILL budget explicitly.

**Numeric exit criteria** (clean soak — all of):

- **N consecutive clean cycles per profile.** No fixed N is baked into the
  tool; the operator picks N appropriate to the profile's cadence (a
  `streak` of `.` in the report's `[…]` sequence, `current=ok` with
  `currentRun >= N`) and states it when reading the report.
- **Zero contract regressions vs baseline** — the bun-window `error_kind`
  histogram introduces no kind absent from the baseline window at a
  comparable-or-lower rate; a bun-only error kind is a clean-soak blocker.
- **No orphaned tmux sessions** — the report's orphaned-tmux count is `0`
  throughout the window (sessions on `-L agentusage-scrape` older than 180s,
  the same 3x-budget threshold the scrape driver itself sweeps at).
- **Latency within budget** — the bun window's `p95` schedule-drift and
  `explicit-budget-timeouts` are not materially worse than the baseline
  window's.

Any single miss is a failed soak: clear the override (rollback, above) and
debug the bun leg with zero production impact — the uv leg never stopped
being authoritative for that profile.
