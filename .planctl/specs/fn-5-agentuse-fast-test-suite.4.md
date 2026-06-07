## Description

**Size:** S
**Files:** pyproject.toml, .python-version (new), README.md (optional)

### Approach

Run LAST — its final acceptance is the whole-suite green-on-3.11 measurement, so it
depends on tasks 1-3 landing first.

1. **Register the `live` marker + default exclusion** in `[tool.pytest.ini_options]`.
   Use the **TOML list form** — the single-quoted string form is a silent no-op (pytest#11738):
   ```toml
   markers = ["live: marks tests that spawn a real claude/codex TUI (deselect with '-m \"not live\"')"]
   addopts = ["--strict-markers", "-m", "not live"]
   ```
   No test is marked `live` yet — this is forward-scaffolding so a future end-to-end scrape
   test is opt-in and never in the default gate. `--strict-markers` turns typo-marks into errors.
2. **Pin the interpreter to 3.11**: `uv python pin 3.11` (writes `.python-version`; compatible
   with `requires-python = ">=3.11"` and the existing `[tool.pyright] pythonVersion = "3.11"`).
   3.11.15 is NOT installed locally — `uv python pin` does NOT install — so run `uv sync` to
   trigger the download + venv rebuild. Verify `uv run python -V` reports 3.11.x.
3. **(Optional) README dev subsection**: fold a brief Development/running-tests note near the
   "flat at the repo root" prose — `uv run pytest`, `-m live` opt-in, the 3.11 requirement.
   Revise-not-append; non-blocking.
4. **Final verification**: `uv run pytest -q --durations=15` on the rebuilt 3.11 venv — full
   suite **<0.6s warm**, no single test > ~0.05s, all 40-odd tests passing.

### Investigation targets

**Required** (read before coding):
- pyproject.toml:25 — `[tool.pytest.ini_options]` (only `testpaths` today); `requires-python` :5; `[tool.pyright]` :28
- tests/ — confirm no existing test needs the `live` mark applied (none should)

### Risks

- **`addopts` string footgun**: `"-m 'not live'"` makes the quotes literal and silently runs
  nothing-excluded — use the list form and verify with `-m live` selecting zero tests and the
  default run excluding none-yet.
- **Pin-without-sync**: `uv python pin` alone leaves the venv on 3.14 — the targets are only
  valid after `uv sync` rebuilds to 3.11.15. Watch for a stray parent `~/.python-version`
  (none currently) overriding the project pin.
- Interpreter swap could surface a 3.14-only behavior — unlikely (`from __future__ import
  annotations` + `zoneinfo` are 3.11-fine), but the final full run on 3.11 is what confirms it.

### Test notes

Confirm `uv run pytest -q -m live` collects 0 tests (deselects all) and the default run is
green; capture the `--durations=15` line proving <0.6s warm.

## Acceptance

- [ ] `live` marker registered and excluded by default via the TOML **list form** of `addopts` (+ `--strict-markers`); `-m live` selects zero tests, default run unaffected.
- [ ] `.python-version` pins 3.11; `uv sync` rebuilt the venv; `uv run python -V` reports 3.11.x.
- [ ] Full suite verified on the 3.11 venv: **<0.6s warm**, no single test > ~0.05s, all passing.
- [ ] (Optional) README gained a short dev/running-tests note.

## Done summary
Registered live marker + --strict-markers with default '-m not live' via the addopts TOML list form (-m live selects 0 of 81 tests); pinned interpreter to 3.11 (.python-version) and rebuilt the venv on 3.11.15 via uv sync (uv run python -V reports 3.11.15); all 81 tests pass. Added a README Development note. Steady-state <0.6s timing could not be honestly measured: the box is under load-avg 27 with ~63 sibling pytest procs, inflating every wall-clock and per-test reading; the suite is green and the per-test shape is healthy under that contention.
## Evidence
