## Description

Originating finding: **F1** (auditor "Should Fix" section, evidence path
`daemon.py:173-178`). The current `asyncio.wait_for(...)` in
`account_loop` caps each scrape at 60s:

```python
rendered = await asyncio.wait_for(
    loop.run_in_executor(
        executor, scrape, acct["target"], acct["passthrough"]
    ),
    timeout=60,
)
```

Auditor's worst-case decomposition: `ready_wait=2.5s` + slash idle pump
(0.6s) + `appear="5h limit"` `SENTINEL_TIMEOUT=15s` + final
`child.expect(EOF, timeout=5)` ≈ 22s of internal timeouts alone, before
pexpect spawn + a cold-start `claude` doing auth/profile/plugin-sync.
The executor thread is uncancellable (the comment at `daemon.py:170-172`
acknowledges this), so a timeout leaves the thread orphaned in the pool
and the account produces only `.error.json` until the wedged scrape
finishes naturally.

Raise the timeout to 120s. Still well under the 60–180s cycle floor
(`delay = random.uniform(60, 180)` at `daemon.py:167`), so no overlap
risk; absorbs realistic cold-start slowness without poisoning the loop.

## Acceptance

- [ ] `timeout=60` → `timeout=120` at `daemon.py:173-178`.
- [ ] No other changes to `account_loop` semantics (error envelope,
      sleep-for, jitter ordering all preserved).
- [ ] Daemon boots cleanly; one full cycle per account produces a
      fresh `<id>.json` with no `<id>.error.json` left behind.

## Done summary
Raised asyncio.wait_for timeout in account_loop from 60s to 120s at daemon.py:177 to absorb claude cold-start slowness without orphaning executor threads.
## Evidence
