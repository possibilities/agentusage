## Overview

The agentuse per-account scrape loop caps each `scrape()` call at 60s via
`asyncio.wait_for`, but a `claude` cold-start (auth/profile/plugin-sync) can
realistically blow past that — the underlying executor thread is
uncancellable, so a wedged scrape leaves that account producing only
`.error.json` envelopes until the orphaned thread completes naturally.
Raise the timeout so transient cold-start slowness doesn't poison the loop
while staying well under the 60–180s cycle floor.

## Acceptance

- [ ] `asyncio.wait_for` timeout in `account_loop` raised from 60s to 120s.
- [ ] Daemon still respects the 60–180s cycle floor (no overlap risk).
- [ ] Manual smoke: daemon boots, runs one cycle per account, writes fresh
      `.json` without `.error.json` for at least one round.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Auditor's worst-case math (cold-start sum >60s) plausible on a 5-account claude/codex mix; concrete user impact (silent staleness streak per account); one-line fix at `daemon.py:173-178`. |
| F7     | culled | —    | Epic explicitly biases toward simplicity; daemon is greenfield with a single-operator feedback loop (stale data is immediately visible in the TUI). Pin behavior post-production-validation, not before. |

## Out of scope

- Adding a regression test suite for `write_atomic`, `_initial_delay`, or
  the `account_loop` error envelope (F7 deferred until a real regression
  motivates the specific behavior to pin).
- Reworking error-path backoff or escalation (F2 — auditor accepted as
  consistent with epic simplicity bias).
- Code-clarity polish on the `+1` executor slot, `TypeError` defensive
  catch, sync-file-read note, or pexpect/pyte encoding comment (F3, F4,
  F5, F6 — all tier-0 documentation niceties).
