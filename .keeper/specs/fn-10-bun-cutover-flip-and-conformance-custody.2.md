## Description

**Size:** M
**Files:** tests/fake-tui.ts, tests/conftest.py

### Approach

Port tests/fake_tui.py to a bun script with identical observable behavior: multi-modal (`auth status` argv prints configurable loggedIn JSON and exits; otherwise alt-screen entry bytes, optional mount delay, absorb ctrl-U then slash text then CR, replay the case transcript, tolerate and ignore unknown argv like the codex bypass flag, stubborn-child fork mode for the reaping cases). Then point the existing python conformance harness's spawn path at the bun fake TUI so the ALREADY-GREEN dual-run parity suite (python CLI vs bun CLI, all 14 corpus scenarios, auth forks, mount delays, reaping) validates the port end-to-end against both implementations — the strongest possible check, available only while the python CLI still exists. The python fake TUI file stays on disk untouched (deleted with the rest of python later); after this task nothing spawns it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- tests/fake_tui.py — the behavior spec, byte-for-byte (alt-screen sequence, input gating, replay pacing, auth mode, stubborn-child mode)
- tests/conftest.py — run_scrape_cli/run_both_clis spawn wiring and where the fake TUI path is resolved
- tests/fixtures/corpus/*/case.json — the per-case knobs (logged_in, mount delay) the fake TUI consumes

### Risks

- Input-absorb timing differs between python select loops and Bun stdin streams; the dual-run suite catches behavioral drift, but watch the mount-delay parametrized cases specifically — they exist to catch exactly this.

### Test notes

`AGENTUSAGE_REQUIRE_PARITY=1 uv run pytest tests/test_dual_run_cli.py` green with the bun fake TUI spawned for every case is the whole verification.

## Acceptance

- [ ] The dual-run parity suite passes all scenarios with fake-tui.ts as the spawned TUI for both CLIs, zero skips under the promotion env
- [ ] The bun fake TUI honors auth-status mode, mount delays, unknown-argv tolerance, and the stubborn-child reaping mode
- [ ] No test path spawns fake_tui.py anymore

## Done summary
Ported tests/fake_tui.py to tests/fake-tui.ts (bun) with byte-identical behavior; repointed conftest.py and test_corpus_smoke.py at it. Dual-run parity suite green (22 passed, zero skips under AGENTUSAGE_REQUIRE_PARITY=1) driving the bun fake through both CLIs; nothing spawns fake_tui.py anymore.
## Evidence
