## Description

**Size:** M
**Files:** package.json, pyproject.toml, daemon.py, scrape.py, src/api.ts, src/index.ts, test/picker.test.ts, test/fixtures/pick-once.ts, test/flock.test.ts, tests/test_daemon_idle_stale_guard.py, README.md, CLAUDE.md, uv.lock, bun.lock

### Approach

Rename every `agentuse` reference inside THIS repo to `agentusage` WITHOUT
moving the repo directory (the dir `mv` is the cutover task `.4`). The
package's own install works with the new name in the old dir, so this lands
and passes lint in place. Edit the four hand-inlined XDG leaf strings, the
manifest names, the two coupled pairs in lockstep, the cosmetic identity
strings, and the docs; then REGENERATE the lockfiles (never hand-edit).

### Investigation targets

**Required** (read before coding):
- src/api.ts:51 — `join(homedir(), ".local","state","agentuse")` TS state leaf; :91 config leaf. Hand-inlined, no shared constant.
- daemon.py:219 — `STATE_DIR = ... / "agentuse"`; :145 — `_xdg_config_home() / "agentuse" / "config.yaml"`.
- scrape.py:244 `prefix="agentuse-scrape-"` ↔ daemon.py:264 filter `"agentuse-scrape-"` (+ docstring :251) — COUPLED PAIR feeding the idle/stale guard; rename BOTH or neither.
- test/picker.test.ts:403 `AGENTUSE_TEST_STATE_DIR` ↔ test/fixtures/pick-once.ts:11,13 — COUPLED PAIR (flock race test env var); rename both.
- daemon.py:505,827 loggers `getLogger("agentuse.<id>")`/`("agentuse.main")`; ~9 `[agentuse]` stderr prefixes; :476 notification title — cosmetic identity strings.
- package.json:2 name `agentuse`→`agentusage`; pyproject.toml:2 `agentuse-py`→`agentusage-py` (asymmetric — `-py` is a separate token).
- CLAUDE.md — AGENTS.md is a SYMLINK to it; edit in place, never rm+recreate.

### Risks

- Coupled pairs: renaming one half of `agentuse-scrape-` silently breaks the idle guard (daemon misjudges idle). Both halves move together.
- Lockfiles carry the name (uv.lock:6 `agentuse-py`, bun.lock:6 `agentuse`) — regenerate via `uv lock` / `bun install`, never hand-edit, or checksum mismatch.
- The `package.json` exports `./flock` subpath is unaffected by the name field, but consumers importing `agentuse/flock` flip in the consumer repos (not here).

### Test notes

Full matrix in place: `bun lint` (biome + tsc --noEmit), `bun test`, `ruff`, `uv run pytest`. The flock tripwire (test/flock.test.ts) and the Bun.YAML config-shape test (picker.test.ts:509) must stay green.

## Acceptance

- [ ] All four XDG leaf strings + both manifest names read `agentusage` / `agentusage-py`
- [ ] Both coupled pairs renamed in lockstep; cosmetic logger/prefix/notification strings renamed
- [ ] uv.lock + bun.lock REGENERATED (not hand-edited) carrying the new name
- [ ] README + CLAUDE.md (via the in-place edit) updated forward-facing; AGENTS.md symlink intact
- [ ] `bun lint` + `bun test` + `ruff` + `uv run pytest` green; repo directory still named `agentuse`

## Done summary

## Evidence
