## Description

**Size:** M
**Files:** src/parse-claude-usage.ts, src/parse-codex-status.ts, src/parse-bridge.ts

### Approach

Port both panel parsers 1:1, strict-by-design: any format divergence produces a typed error (discriminated `{ok:false, errorType, message}` results or thrown named errors surfaced as such at the boundary — keeper house style), never partial data. Claude: bars-vs-breakdown branching (`"% used"` positive signal), case-insensitive header gate on the bars path, block finder with the 0%-window null-reset tolerance (nonzero window missing its reset still errors), named-zone resolution through the task-1 wrapper, `deriveLiftAt` (soonest `resets_at` among ≥100% windows, ISO string compare). Codex: sentinel gate, percent inversion (`100 - pct_left`), optional Codex-Spark block split, date-less and date-bearing reset suffixes resolved system-local. Keep every shared sentinel literal single-sourced and exported (NO_SUB_SENTINEL, PANEL_HEADER, USAGE_ENDPOINT_RATE_LIMIT_SENTINEL, API_BILLING_SENTINEL, PANEL_SENTINEL, SPARK_SENTINEL) so the driver task imports rather than redeclares. Port the load-bearing rationale comments verbatim-in-spirit (forward-facing voice). Add `src/parse-bridge.ts`: a tiny entry reading panel text on stdin with `--target claude|codex --now <offset-iso>` argv, printing the parsed usage JSON + exit 0, or `{"error_type": "<PythonExceptionName>", "message": "..."}` + exit 1 — error_type strings must equal the Python exception class names (ClaudeUsageParseError, ClaudeUsageEndpointRateLimited, NoActiveSubscription, CodexStatusParseError) so the parity module can assert them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- parse_claude_usage.py — full file; the branching precedence (bars > endpoint-rate-limit > no-sub > api-billing > error) and 0%-null-reset tolerance at :178-192 are the subtle parts
- parse_codex_status.py — full file; RESET_SUFFIX optionality and spark split at :119-128
- agentusage/scrape_cli.py:96-104 — how parsers are consumed (PARSERS map) and which exceptions map to which arms
- tests/test_parse_claude_usage.py + tests/test_parse_codex_status.py — every assertion is a parity target; the fixtures are importable module constants

**Optional** (reference as needed):
- ~/code/keeper/src/usage-scraper-worker.ts:456-481 — keeper's deriveLiftAt (the eventual dedup target; match semantics)

### Risks

- Regex translation drift: Python `re` and JS RegExp differ on subtle syntax; port each pattern with its test cases, not by eye.
- Float shape: `percent_used` must deserialize as a number such that parsed-JSON deep-equality with Python's `42.0` holds (JSON number equality, not string equality).

### Test notes

Real coverage arrives with the parity module (task 7); here, a handful of bun:test smoke cases over the imported fixture shapes is enough to develop against. `bun run typecheck` clean.

## Acceptance

- [ ] `echo "<subscribed fixture>" | bun src/parse-bridge.ts --target claude --now 2026-05-29T12:00:00-04:00` prints a usage object with session/week blocks whose resets_at are seconds-precision offset ISO strings, exit 0
- [ ] The bridge prints `{"error_type": "NoActiveSubscription", ...}` exit 1 for the no-sub breakdown screen and `{"error_type": "ClaudeUsageParseError", ...}` exit 1 for an empty screen
- [ ] Codex bridge output inverts percent (99% left → percent_used 1) and emits spark blocks only when the spark sentinel is present
- [ ] Sentinel literals are exported from exactly one module (no duplicate string constants across src/)

## Done summary
Ported parse_claude_usage.py and parse_codex_status.py 1:1 to strict TS parsers (src/parse-claude-usage.ts, src/parse-codex-status.ts) over the task-1 reset-time wrapper, with single-sourced exported sentinels and deriveLiftAt. Added src/parse-bridge.ts mapping thrown named errors to Python exception-class error_type strings. bun test (39), typecheck, biome, and pytest (117) all green.
## Evidence
