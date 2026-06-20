## Overview

The `daemon.py:500` guard that prevents idle heartbeats from clobbering a stale envelope is load-bearing but has no unit test. An accidental inversion would silently deliver `idle` status to clients for accounts whose last fetch failed. This epic adds targeted coverage for that single condition.

## Acceptance

- [ ] A test exercises the path where a stale envelope exists and an idle skip fires, asserting the written envelope retains `status: stale`
- [ ] No existing test assertions are weakened

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F2 | kept | .1 | Load-bearing guard at daemon.py:500 is untested; an accidental inversion silently masks a stale account as idle |

## Out of scope

- Refactoring the idle-skip path
- Adding TUI or async integration tests for the daemon
