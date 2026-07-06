## Description

**Size:** M
**Files:** tests/test_bun_parity.py, tests/test_dual_run_cli.py, tests/conftest.py, agentusage/scrape_cli.py, tests/fixtures/corpus/

### Approach

The epic's proof. (1) `AGENTUSAGE_NOW` seam, additive: `agentusage/scrape_cli.py` reads the env var (offset-bearing ISO) and threads it as `now=` to its parser; absent → unchanged wall-clock behavior; existing tests untouched. (2) `tests/test_bun_parity.py`: for every corpus case AND every importable inline parser fixture from the existing test modules, run Python `parse(text, now=pinned)` in-process and the bun parse-bridge as a subprocess with the same `--now`; assert parsed-JSON deep-equality on success and error_type-name equality on raises (map pytest.raises expectations to bridge error_type strings). (3) `tests/test_dual_run_cli.py`: for every corpus scenario, spawn BOTH CLIs with `--command tests/fake_tui.py`, sandboxed HOME (trust-file writes land in the sandbox, mirroring the existing writes-no-state test), pinned AGENTUSAGE_NOW + TZ, identical env (TERM/LINES/COLUMNS/LANG); assert semantic parity — parsed-JSON deep-equality, exact resets_at strings, exactly one stdout line with trailing newline, matching exit codes — including the auth-probe fork (fake TUI loggedIn true/false/garbage), parametrized mount delays (ready-wait race), and a reaping case where the fake TUI forks a stubborn child and the harness asserts no survivors after each CLI's cleanup. (4) Skip discipline: bun-or-tmux-absent hosts skip these modules with a reason; `AGENTUSAGE_REQUIRE_PARITY=1` promotes any skip to failure (the designated-environment gate making green non-vacuous). (5) A `live`-marked parity case runs one real claude scrape through both CLIs (excluded by default). (6) Regenerate corpus expected-outputs from the Python CLI now that the env seam exists, confirming the generator note from the corpus task.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- agentusage/scrape_cli.py:252-298 — where the now= seam threads into run()
- tests/test_scrape_cli.py:42-49 — the one-stdout-line capture pattern to mirror at subprocess level
- tests/test_scrape_cli.py:452-462 — the HOME-sandbox writes-no-state pattern
- tests/fixtures/corpus/ + tests/corpus_schema.md — case shape, pinned now/TZ fields
- pyproject.toml:27-30 — marker registration and addopts; add the parity skip logic without disturbing `-m "not live"` defaults

**Optional** (reference as needed):
- tests/test_parse_claude_usage.py / test_parse_codex_status.py — the importable fixture constants and raise-expectation inventory the parity module consumes

### Risks

- Two subprocesses at a seconds-precision boundary can straddle a today/tomorrow roll if the seam leaks wall clock anywhere — the parity module should fail loudly on resets_at mismatch, and the pinned-now design makes any such failure a real bug, not flake.
- Skip-guards that are too eager make the suite vacuously green; the REQUIRE_PARITY promotion is the counterweight and must be exercised on this box before the epic closes.

### Test notes

This task IS the test surface. Close-out runs: `uv run pytest` (green, parity active) and `AGENTUSAGE_REQUIRE_PARITY=1 uv run pytest tests/test_bun_parity.py tests/test_dual_run_cli.py` (zero skips, zero failures) on this box.

## Acceptance

- [ ] Parity module covers every corpus case and every inline parser fixture with deep-equality or error-type-equality assertions against the bridge
- [ ] Dual-run module passes all corpus scenarios for both targets including auth-probe forks, mount-delay parametrization, wrap-split and spinner structural cases, and the stubborn-child reaping case
- [ ] AGENTUSAGE_NOW absent leaves Python CLI behavior and all pre-existing tests unchanged; existing test files remain untouched
- [ ] With bun or tmux absent the suite still passes via reasoned skips; AGENTUSAGE_REQUIRE_PARITY=1 turns those skips into failures and passes with zero skips on this box
- [ ] `uv run pytest -m live` runs the real-binary parity case successfully when invoked by hand

## Done summary

## Evidence
