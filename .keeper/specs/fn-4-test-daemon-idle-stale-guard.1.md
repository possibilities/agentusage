## Description

Finding F2 from audit of fn-3-scrape-envelope-status-and-subscription. Evidence path: daemon.py:500 has `if prior.get("status") != "stale":` — a guard that prevents the idle-heartbeat branch from running when the current envelope is stale. The comment reads "IMPORTANT: never overwrite a `stale` status with `idle`". grep of tests/test_parse_claude_usage.py returns one docstring hit on "stale" about a different behavior; this state-machine guard is unexercised.

Add a test that sets up an existing envelope with `status: stale`, triggers the idle-skip condition (`idle_for > IDLE_THRESHOLD_S`), and asserts the written-back envelope preserves `status: stale` rather than flipping to `idle`. Mock `_latest_agent_activity()` and `_load_envelope()` to sidestep the full async/TUI coupling.

## Acceptance

- [ ] Test asserts stale envelope is preserved when idle-skip fires
- [ ] Test lives in tests/ and passes with `uv run pytest`

## Done summary
Added tests/test_daemon_idle_stale_guard.py pinning the daemon.py:500 stale-guard: seeds a stale envelope, forces the idle window to exceed IDLE_THRESHOLD_S, runs one cycle of account_loop under asyncio.run with scrape/initial_delay/_latest_agent_activity monkeypatched, and asserts the on-disk envelope stays status='stale'. Mutation-verified: inverting the != guard to == flips the assertion to 'idle'.
## Evidence
