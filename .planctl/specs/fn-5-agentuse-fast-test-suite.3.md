## Description

**Size:** S
**Files:** tests/test_scrape_helpers.py (new), tests/test_daemon_helpers.py (new)

### Approach

Same flat-repo test conventions (`from __future__ import annotations`, `sys.path` shim,
`# noqa: E402`). All functions here are pure (or pure given an isolated home), so these
are fast table-driven tests.

**`tests/test_scrape_helpers.py`** — `scrape._extract_claude_profile` (import `scrape`,
NOT `scrape_one` — a real mis-import trap): `--arthack-profile foo` (space form),
`--arthack-profile=foo` (equals form), flag absent, flag interleaved with passthrough
args, multiple occurrences (last wins), trailing `--arthack-profile` with no value.
Assert the returned `(remaining_args, profile)` tuple for each.

**`tests/test_daemon_helpers.py`**:
- `_parse_aware_isoformat`: aware stamp → datetime; **naive stamp (e.g. `"2026-06-15T09:00:00"`)
  → `None`** (the non-obvious branch); garbage string → `None`; non-str (int/None) → `None`.
- `_resolve_multiplier`: **monkeypatch `daemon.Path.home` to a `tmp_path`** (or write a tmp
  `.claude-profiles/<profile>/.claude.json`) BEFORE calling — it reads the real FS at call
  time. Cover a known tier → its `TIER_MULTIPLIERS` value, an unknown tier → 1x fallback,
  and a missing/unreadable file → 1x fallback. Check the `TIER_MULTIPLIERS` / `MAX_CLAUDE_JSON_BYTES`
  constants near the top of daemon.py for the exact tier strings/values.
- `_screen_excerpt`: under `max_lines` → returned verbatim (blank lines dropped, each line
  rstripped + truncated to 240 chars); over `max_lines` → exact head/tail split
  (`head = max_lines//2`, `tail = max_lines - head - 1`) with the literal
  `"... N lines omitted ..."` marker and correct omitted count.
- `_build_envelope`: assert the returned key set == `daemon.ENVELOPE_KEYS` and
  `schema_version == daemon.ENVELOPE_SCHEMA_VERSION`. Build the `Account` TypedDict inline
  (`{"id","target","passthrough","multiplier"}`) — copy the construction at
  test_daemon_idle_stale_guard.py:235.

### Investigation targets

**Required** (read before coding):
- scrape.py:97 — `_extract_claude_profile`
- daemon.py:290 — `_parse_aware_isoformat`; :324 `_screen_excerpt`; :419 `_build_envelope`
- daemon.py:81 — `_resolve_multiplier` (reads `~/.claude-profiles/<profile>/.claude.json`)
- daemon.py:402 — `ENVELOPE_KEYS`; and `ENVELOPE_SCHEMA_VERSION`, `TIER_MULTIPLIERS`, `MAX_CLAUDE_JSON_BYTES` near top
- tests/test_daemon_idle_stale_guard.py:235 — inline `Account` construction to copy

### Risks

- `_resolve_multiplier` reads the developer's real home if `Path.home` isn't patched — the
  test must isolate it or it's non-hermetic. `daemon` import already calls it for the host's
  real profiles at module load (harmless 1x fallback + stderr), but the TEST must isolate.
- Importing `scrape` pulls `pexpect` + `pyte` (heavier than the pure parsers) — fine, both are
  installed deps; just don't import `scrape_one`.

### Test notes

`uv run pytest -q tests/test_scrape_helpers.py tests/test_daemon_helpers.py -v`; all pass, each fast.

## Acceptance

- [ ] `_extract_claude_profile` covered for both flag forms, absent, interleaved, multi-occurrence, and no-value cases.
- [ ] `_parse_aware_isoformat` covers aware/naive/garbage/non-str; `_resolve_multiplier` covers known-tier/unknown-tier/missing-file with a monkeypatched home.
- [ ] `_screen_excerpt` asserts the exact head/tail split, marker string, and 240-char cap; `_build_envelope` asserts key set == `ENVELOPE_KEYS`.
- [ ] All new tests hermetic and passing.

## Done summary

## Evidence
