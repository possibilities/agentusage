## Overview

Take the 29-test `agentuse` suite from ~2.6-2.9s warm to **<0.6s** and close
its real coverage gaps. The entire slowdown is artificial: five daemon tests
each pay a hardcoded `await asyncio.sleep(0.5)` (~2.5s, ~95% of run time) just
to let one loop cycle fire before cancelling. Replace that with a deterministic
wait on the loop's observable state-file write. Then backfill the highest-value
untested logic — the entire codex parser, claude reset-time resolution, and the
pure scrape/daemon helpers — register a `live` marker so future end-to-end
scrape tests stay out of the gate, and pin the interpreter to 3.11 so local and
CI agree. Charter: `~/docs/2026-06-06-fast-test-suites/agentuse.md`.

## Quick commands

- `uv run pytest -q --durations=15`  # expect <0.6s warm, no single test > ~0.05s, all passing
- `uv run pytest -q -m live`         # opt-in: any future live scrape tests (none yet)
- `uv run python -V`                 # expect Python 3.11.x after the interpreter pin

## Acceptance

- [ ] Full suite runs **<0.6s warm** with no single test > ~0.05s, all passing.
- [ ] No fixed `asyncio.sleep` gate remains in `tests/test_daemon_idle_stale_guard.py`; the five guard tests keep their exact intent (stale-never-clobbered-to-idle, `lift_at` rides forward, cooldown engages on `active` / bypasses on `stale`).
- [ ] `parse_codex_status.parse` + `_resolve_today_time` + `_resolve_date_time` covered; claude `_resolve_session`/`_resolve_week` covered with pinned `now=`.
- [ ] `scrape._extract_claude_profile` and the daemon pure helpers (`_parse_aware_isoformat`, `_resolve_multiplier`, `_screen_excerpt`, `_build_envelope`) covered.
- [ ] `live` marker registered + excluded by default via the **TOML list form** of `addopts`; interpreter pinned to 3.11 and the full suite verified green on the rebuilt 3.11 venv.

## Early proof point

Task that proves the approach: `.1` (de-sleep the daemon harness) — it delivers
~95% of the speed win and validates the deterministic-wait pattern. If it fails
(poll never trips / seed-vs-rewrite ambiguity): fall back to monkeypatching
`daemon.write_atomic` to set an `asyncio.Event` the test awaits, which fires
exactly on the cycle's write and is immune to the seed-equals-terminal case.

## References

- Charter (audit evidence base): `~/docs/2026-06-06-fast-test-suites/agentuse.md`
- `README.md` — client-facing envelope/data-format contract (envelope field semantics)
- Origin of the daemon test file: closed epic `fn-4-test-daemon-idle-stale-guard`
- pytest `addopts` list-form footgun: pytest-dev/pytest#11738
- epic-scout: all four existing epics (fn-1..fn-4) are `done` — no inter-epic deps or overlaps

## Docs gaps

- **pyproject.toml**: `[tool.pytest.ini_options]` gains `markers` + `addopts` (handled in task `.4`, not a separate doc).
- **README.md**: optional Development/running-tests subsection (`uv run pytest`, `-m live` opt-in, 3.11 requirement) — revise-not-append near the "flat at the repo root" prose; non-blocking, folded into task `.4`.

## Best practices

- **`addopts` must use the TOML list form** `["-m", "not live"]`: the single-quoted string form makes the quotes literal and the filter silently no-ops (pytest#11738).
- **Never swallow `CancelledError` inside a coroutine under test**; the top-level test's `except CancelledError` after its own `task.cancel()` is fine, but a real loop-body bug should surface, not get absorbed.
- **`asyncio.sleep(0)` does not guarantee a single scheduler tick** — the de-sleep must wait on a condition (observable write), never a fixed tick count.
- **`uv python pin` does not install**: `uv sync` triggers the 3.11.15 download + venv rebuild; the speed/pass targets are only valid measured on the rebuilt venv.

## Snippet context

No snippets attached: `promptctl find-snippets` returned no hits for the pytest /
asyncio-test / uv-python-pin topics, and the inherited `sketch/agentuse-fast-test-suite`
bundle was the deliberate, auditable empty case. This repo's test conventions live
entirely in-file (the existing `test_parse_claude_usage.py` / `test_picker.py` /
`test_daemon_idle_stale_guard.py` templates), not in the snippet store — workers
follow those files directly.
