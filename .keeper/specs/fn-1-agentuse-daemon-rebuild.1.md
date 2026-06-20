## Description

**Size:** S
**Files:** `run_all.py` (delete), `dump_plans.py` (delete), `scrape.py` (refactor), `pyproject.toml` (rename), `uv.lock` (regenerate)

### Approach

Lay a clean foundation for the daemon build in task 2. Three coordinated moves:

1. **Delete the spike orchestration:** remove `run_all.py` and `dump_plans.py` entirely. Capture `dump_plans.py:13-17`'s `TIER_LABELS` knowledge as a one-line comment near where task 2 will define the ACCOUNTS registry — traces the 1/5/20 multipliers to the source-of-truth tier strings (`default_claude_ai`=1, `default_claude_max_5x`=5, `default_claude_max_20x`=20).
2. **Refactor `scrape.scrape()` to return text:** change the signature to `scrape(target_name: str, passthrough_args: list[str]) -> str`. Line 128 of `scrape.py` is the natural return point. Delete the tmp-file write at lines 129-139 entirely, and the `print(path)` at line 139. Delete the `main()` CLI wrapper at lines 149-167. Move the pexpect cleanup (Ctrl-C + EOF wait, lines 141-146) into a `try/finally` block so it runs on exception paths too — current code only runs on success.
3. **Rename the project:** in `pyproject.toml`, set `name = "agentuse"`. Replace the `description` with a verb phrase like *"Poll Claude and Codex usage per account and write structured JSON state"* (parent `/Users/mike/code/CLAUDE.md` requires a verb-phrase description; feeds `choosectl list-project-descriptions`). Keep `[tool.uv] package = false`. Regenerate `uv.lock` with `uv lock`.

Conventions to follow (per repo-scout): flat layout (no `src/`), Python ≥3.11, module-level UPPER_CASE constants, docstrings as module headers, strict-by-design parsers stay untouched.

### Investigation targets

**Required**:
- `/Users/mike/code/agentuse/scrape.py:97-147` — `scrape()` function. Line 128 returns the rendered text; lines 129-139 are the tmp-file write to delete; lines 141-146 are the cleanup to move into `try/finally`.
- `/Users/mike/code/agentuse/scrape.py:149-167` — `main()` CLI wrapper to delete.
- `/Users/mike/code/agentuse/scrape.py:28-51` — `TARGETS` dict; keep verbatim (daemon imports it).
- `/Users/mike/code/agentuse/run_all.py` — delete in full.
- `/Users/mike/code/agentuse/dump_plans.py:13-17` — `TIER_LABELS` mapping. Capture the knowledge as a comment near task 2's ACCOUNTS registry, then delete the file.
- `/Users/mike/code/agentuse/pyproject.toml` — update `name` and `description`. Keep `[tool.uv] package = false`.

**Optional**:
- `/Users/mike/code/CLAUDE.md` — compound-word naming + verb-phrase description convention.

### Risks

- `scrape()` currently prints sentinel warnings to stderr (`scrape.py:120, 123`). Leave those `print(..., file=sys.stderr)` calls as-is for this task; daemon-level `logging` routing happens in task 2.
- `uv.lock` regeneration: run `uv lock` after the name change so the lockfile reflects the new project name. Verify with `grep '^name' uv.lock`.
- No tests exist in the repo — verification is a manual smoke (see Test notes).

### Test notes

- Manual smoke: `uv run python -c "from scrape import scrape; rendered = scrape('codex', []); print(len(rendered), 'chars')"` should print a positive byte count and exit 0, writing no `/tmp/tuiuse-*` or `/tmp/agentuse-*` files (verify with `ls /tmp/ | grep -E 'tuiuse|agentuse'` returning empty).
- `grep -rn "tuiuse" --include='*.py' --include='*.toml' .` should turn up nothing in source (matches in `.venv/`, `__pycache__/`, `.planctl/state/` are acceptable — those refresh on next use).

## Acceptance

- [ ] `run_all.py` and `dump_plans.py` are deleted from the working tree.
- [ ] `scrape.scrape(target_name, passthrough_args)` returns a `str` (rendered screen text). No tmp file is written; no stdout `print(path)`.
- [ ] `scrape.py` has no `main()` CLI wrapper and no `argparse` import.
- [ ] pexpect cleanup (Ctrl-C + EOF wait) runs on both success and exception paths via `try/finally`.
- [ ] `pyproject.toml`: `name = "agentuse"`, `description` is a verb-phrase about the daemon's purpose.
- [ ] `uv.lock` regenerated and reflects the new project name (`grep '^name' uv.lock` shows `agentuse`).
- [ ] Manual smoke: `uv run python -c "from scrape import scrape; print(len(scrape('codex', [])), 'chars')"` exits 0, prints a positive byte count, leaves no `/tmp/tuiuse-*` or `/tmp/agentuse-*` files.
- [ ] `dump_plans.py`'s `TIER_LABELS` knowledge is captured as a one-line comment in `scrape.py` (or staged for task 2's `daemon.py`) so the 1/5/20 → tier-string mapping isn't lost.

## Done summary
Deleted spike orchestration (run_all.py, dump_plans.py); refactored scrape.scrape() to return rendered text via try/finally cleanup with no tmpfile or main CLI; renamed project tuiuse -> agentuse and regenerated uv.lock; preserved TIER_LABELS knowledge as a tier-mapping comment in scrape.py for task 2's ACCOUNTS registry.
## Evidence
