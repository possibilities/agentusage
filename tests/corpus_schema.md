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
  expected.json     # the discriminated-contract JSON the CLI must print on stdout
```

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

`tests/fixtures/corpus/generate.py` regenerates every `expected.json` (and the
transcripts + `case.json`). Canonical implementation is Python: each transcript
is fed through the real pyte render path (mirroring `scrape.scrape`'s screen
construction) and the real parser + CLI arm-builders (`agentusage.scrape_cli`)
under the pinned `now`, reproducing the CLI's `run()` branching exactly. Hand-
writing an expected value would encode a guess instead of the contract.

Regenerate with:

```
uv run python tests/fixtures/corpus/generate.py
```

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
2. Invoke the CLI with `case.argv` plus `--command <path to tests/fake_tui.py>`.
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
