## Description

**Size:** S
**Files:** tests/test_parse_codex_status.py (new), tests/test_parse_claude_usage.py

### Approach

Mirror the existing `test_parse_claude_usage.py` conventions exactly: `from __future__
import annotations`, the `sys.path.insert(0, ...parent.parent)` shim with `# noqa: E402`,
module-level triple-quoted rendered-panel fixtures, a pinned module-level `NOW`, and
`pytest.raises(...)` for the strict error paths.

**New `tests/test_parse_codex_status.py`** — cover `parse` + `_resolve_today_time` +
`_resolve_date_time`:
- Valid session+week panel (fixture must contain literal `5h limit:` and `Weekly limit:`
  rows matching `FIVE_HOUR_RE` / `WEEKLY_RE`); assert `percent_used == 100 - pct_left`
  for both windows (the inversion is the easy-to-break bit).
- Missing `5h limit:` sentinel → `CodexStatusParseError`; present sentinel but malformed
  5h row → error; missing/malformed `Weekly limit:` → error.
- `_resolve_today_time`: HH:MM already passed today → rolls to tomorrow; still-future → today.
- `_resolve_date_time`: date already passed this year → next year; unknown month → `CodexStatusParseError`.
- **Pinned `now` must be tz-aware with an explicit fixed offset** (codex resolves against
  system-local tz via `now.replace(...)`, NOT a `ZoneInfo`), on a **mid-month date** so
  `now.replace(month=..., day=...)` never hits a month-length `ValueError`. Assert
  `resets_at` against that same fixed offset.

**Extend `tests/test_parse_claude_usage.py`** — add direct `_resolve_session`/`_resolve_week`
cases under a pinned `now=` (the current tests only smoke-assert "is a string"):
- `_to_24h` boundaries via session times: `12am` → 00:00, `12pm` → 12:00, plain `3pm` → 15:00.
- Roll-forward boundary: a session time exactly `<= now` rolls to tomorrow; just-after stays today.
- `_resolve_week` year-wrap: a Dec reset with a Jan `now` (or a month/day already passed) → next year.
- Unknown timezone in the reset line → `ClaudeUsageParseError`; unknown month → `ClaudeUsageParseError`.

### Investigation targets

**Required** (read before coding):
- tests/test_parse_claude_usage.py:39 — fixture-string + `NOW` pattern to mirror
- parse_codex_status.py:39 — `_resolve_today_time`; :47 `_resolve_date_time`; :60 `parse`
- parse_codex_status.py:19 — `PANEL_SENTINEL`, `FIVE_HOUR_RE`, `WEEKLY_RE`, `MONTHS`
- parse_claude_usage.py:88 — `_to_24h`; :95 `_resolve_session`; :108 `_resolve_week`

### Risks

- A carelessly chosen pinned `now` (month-end) makes `_resolve_date_time` raise `ValueError`
  unrelated to the code under test — pick a safe mid-month `now`.
- Codex offset drift: asserting `resets_at` without pinning the offset is non-deterministic
  across machines/DST — pin and assert the same explicit offset.

### Test notes

`uv run pytest -q tests/test_parse_codex_status.py tests/test_parse_claude_usage.py -v`;
all new cases pass, each < 0.01s.

## Acceptance

- [ ] `test_parse_codex_status.py` covers valid parse, the `100 - pct_left` inversion, all sentinel/format error paths, today→tomorrow + date→next-year rollover, and unknown-month error.
- [ ] `test_parse_claude_usage.py` gains `_resolve_session`/`_resolve_week` cases: 12am/12pm boundary, `<= now` roll-forward, year-wrap, unknown-tz and unknown-month errors.
- [ ] All new tests deterministic under pinned `now=`, all passing.

## Done summary

## Evidence
