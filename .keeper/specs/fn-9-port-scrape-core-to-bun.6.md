## Description

**Size:** M
**Files:** src/scrape-cli.ts, package.json

### Approach

Port `agentusage/scrape_cli.py` as the Bun entry: identical argv surface (`--target claude|codex` required-choice, `--profile` required, `--command`, `--rows`, `--cols`) and the exact arm/exit mapping — SignedOut result → `{schema_version:1, status:"ok", signed_out:true}` exit 0; driver failure pre-render → error arm with `error_kind: "scrape_failed"`, empty screen_excerpt, exit 1; NoActiveSubscription → run the `claude auth status` probe (same binary override, CLAUDE_CONFIG_DIR set/unset by profile, PATH prepend, 15s timeout, `{"loggedIn": bool}` parse, null on ANY failure) and emit signed_out when definitively logged out else no_subscription, exit 0; parse failure → classify (endpoint-rate-limit exception → upstream_limited; panel evidence present → format_changed; else panel_missing) with `_screen_excerpt` semantics (nonblank, 240-char clamp, head+tail elision at 24 lines), exit 1; success → usage + subscription_active (true claude / null codex), exit 0. Diagnostics and stack traces to stderr only; stdout is exactly one JSON line + newline with an explicit end-of-main flush/drain before exit (Bun#24690-class hazards). Honor `AGENTUSAGE_NOW` (offset-bearing ISO) by threading it as the parsers' `now`; absent → wall clock. Spawn the auth probe with concurrent stdout/stderr drains. Register the bin entry in package.json.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- agentusage/scrape_cli.py — full file; the arm mapping, classifier precedence, excerpt shape, and flush rationale are the port surface
- ~/code/keeper/src/usage-scrape-runner.ts:249-353 — the consumer's validator; signed_out is checked before no_subscription before usage
- tests/test_scrape_cli.py — the arm/exit assertions and _CLASSIFY_CASES table (Epic B translates them; here they are the behavior spec)

**Optional** (reference as needed):
- src/parse-bridge.ts — reuse the same parser error-type surfacing rather than inventing a second mapping

### Risks

- The subscription_active tri-state (true / null / absent-per-arm) and the key-absence rules (no usage/subscription_active keys on the flag arms) are exactly what keeper validates; getting key presence wrong folds the scrape to runner_failure silently.

### Test notes

Task 7's dual-run is the gate; here, drive one ok and one error scenario by hand through the fake TUI and eyeball the JSON against a Python CLI run.

## Acceptance

- [ ] For the same fake-TUI scenario and pinned AGENTUSAGE_NOW/TZ, the Bun CLI and Python CLI print semantically equal JSON with equal exit codes for: subscribed, no-sub (auth probe loggedIn true), signed-out via auth probe (loggedIn false), signed-out pre-send, and a parse-drift error
- [ ] Stdout carries exactly one line ending in a newline on every arm; tracebacks appear only on stderr
- [ ] `bun run <bin>` works from any cwd (no repo-root assumption beyond its own imports)

## Done summary
Ported scrape_cli.py to src/scrape-cli.ts (identical argv, four contract arms 0/0/0/1, auth probe, error-kind classification, AGENTUSAGE_NOW threading) and registered the agentusage-scrape bin. Bun and Python CLIs print semantically-equal JSON with equal exit codes across subscribed/no-sub/signed-out(x2)/parse-drift; lint+typecheck clean, pytest 122 green.
## Evidence
