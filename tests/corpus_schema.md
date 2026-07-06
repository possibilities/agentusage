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
