## Description

**Size:** S
**Files:** tests/test_daemon_idle_stale_guard.py

### Approach

Remove the two `await asyncio.sleep(0.5); task.cancel()` blocks — one inlined in
`_run_stale_guard` (~lines 300-301), one in the shared `_drive_one_cycle`
(~lines 355-356) — and replace each with a deterministic wait on the loop's
observable state-file write, then cancel. `account_loop` writes the envelope via
`write_atomic` and then parks in a long trailing `await asyncio.sleep(...)` (60-180s,
or ~1h for cooldown), yielding control — so a concurrent poll detects the write
within ~1ms and cancels cleanly while the task is parked. Each test drops 500ms → ~1-5ms.

**Poll predicate is the load-bearing decision (seed == terminal-status ambiguity):**
- Idle + cooldown tests (`_run_idle_lift`, `_run_rate_limit_pause`): seed has
  `last_skipped_fetch_at: null`; both branches stamp it. Poll until
  `last_skipped_fetch_at is not None`.
- The three stale-seeded tests (`_run_stale_guard`, `_run_stale_lift`,
  `_run_stale_prior_cooldown_bypass`): seed `status` equals the expected terminal
  `status`, so polling `status` alone cannot distinguish seed from rewrite. Poll
  until `last_failed_fetch_at` **advances past the seeded value** (the stale-writeback
  branch stamps a fresh `failed_at`). For the cooldown-bypass test the existing
  `scrape_calls["count"] >= 1` is an equally valid signal.

Wrap the poll in a generous wall-clock ceiling (e.g. 2s) polled at fine granularity
(`await asyncio.sleep(0.001)`), and `pytest.fail(...)` loudly if it never trips —
never fall through to the final assertion on seed content. Read the file defensively
(`json.loads(state_path.read_text())` may briefly read pre-`os.replace` content; treat
a non-matching predicate as "keep polling", and guard `JSONDecodeError`).

Preferred alternative if the per-predicate approach proves fiddly: monkeypatch
`daemon.write_atomic` to wrap the real call and `set()` an `asyncio.Event`; `await
asyncio.wait_for(event.wait(), timeout=2.0)` then cancel. The seed is written via
`state_path.write_text` (not `write_atomic`), so the event fires exactly on the
cycle's write — immune to the seed-equals-terminal case and uniform across all five.

Consider narrowing the post-cancel `except (asyncio.CancelledError, Exception): pass`
to `except asyncio.CancelledError` so a genuine loop-body bug surfaces (the loop's own
handler already absorbs the stubbed `RuntimeError`). Optional — note it, don't force it.

### Investigation targets

**Required** (read before coding):
- tests/test_daemon_idle_stale_guard.py:300 — inlined sleep-cancel block in `_run_stale_guard`
- tests/test_daemon_idle_stale_guard.py:341 — `_drive_one_cycle` shared helper (sleep at :355)
- tests/test_daemon_idle_stale_guard.py:324 — `_seed_state_dir` (STATE_DIR/EVENTS_LOG redirect)
- daemon.py:544 — cooldown write branch (stamps `last_skipped_fetch_at`)
- daemon.py:594 — idle write branch (stamps `last_skipped_fetch_at`)
- daemon.py:710 — stale-writeback branch (stamps fresh `last_failed_fetch_at`)
- daemon.py:262 — `write_atomic` (uses `os.replace`)

**Optional** (reference as needed):
- daemon.py:507 — `account_loop` `while True` body and its trailing sleeps

### Risks

- Wrong poll predicate → test hangs to its ceiling or passes on seed content. The
  per-branch predicates above are the mitigation; verify each of the five terminal
  statuses still asserts correctly after the swap.
- Cancel must land after the write; the cooldown test parks ~1h, so a wait that
  only "lets the task settle" would hang — the predicate-then-cancel is mandatory.

### Test notes

Re-run `uv run pytest -q tests/test_daemon_idle_stale_guard.py --durations=10`; the
file should drop from ~2.6s to well under 0.1s, all five still passing with unchanged intent.

## Acceptance

- [ ] Both fixed `asyncio.sleep(0.5)` gates removed; no fixed sleep remains as a test gate.
- [ ] Each of the five tests waits on the correct transitioning field (or the write-event), with a loud timeout on failure.
- [ ] All five tests pass with identical assertions/intent; the file runs < 0.1s.

## Done summary
Removed both fixed asyncio.sleep(0.5) gates in the idle/stale guard tests; replaced with a deterministic wait on the loop's wrapped write_atomic (asyncio.Event) plus a loud 2s timeout, cancelling while the loop is parked. All five tests pass with unchanged intent.
## Evidence
