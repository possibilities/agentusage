## Description

**Size:** M
**Files:** parse_claude_usage.py, daemon.py, scrape.py, scrape_one.py, pyproject.toml, tests/test_parse_claude_usage.py (new)

Implement the two-axis envelope contract end to end: detect no-subscription
claude accounts as a successful read, surface staleness and idle in the main
envelope, add `schema_version` + a uniform key set, and short-circuit the
wasted no-sub sentinel wait. This is the code keystone; the README (task .2)
documents the frozen result.

### Approach

**1. `parse_claude_usage.py` — no-sub classification (the load-bearing part).**
Add `class NoActiveSubscription(Exception)` alongside `ClaudeUsageParseError`.
Restructure `parse()` so detection is robust to the observed header-casing
variance:
- Compute `has_bars = PERCENT_RE.search(text) is not None` (the `"% used"`
  rate-limit bars are the positive subscribed signal; the no-sub breakdown
  uses `"% of usage"` / `"% of your usage"`, never `"% used"`).
- If `has_bars`: keep today's strict parse (find `REQUIRED_LABELS`, parse
  session/week/optional sonnet_week). Relax the header gate here to
  case-insensitive (`PANEL_HEADER.lower() in text.lower()`) so the `Usage`
  vs `usage` tab-casing variance doesn't spuriously raise; still raise
  `ClaudeUsageParseError` if bars exist but labels don't (real format drift).
- If not `has_bars`: if the breakdown sentinel `"% of usage"` is present →
  raise `NoActiveSubscription` (panel opened, no plan limits). Otherwise raise
  `ClaudeUsageParseError` (panel never rendered / genuinely changed). Precedence
  is therefore: subscribed-bars > no-sub-breakdown > error. Subscribed accounts
  are unaffected — they always hit the bars path.
- Update the module docstring to mention the no-subscription case.

**2. `scrape.py` — short-circuit the ~180s no-sub wait.** Add a no-sub
sentinel to `TARGETS["claude"]` (e.g. `"appear_nosub": "% of usage"` — the
same string the parser keys on, so the two detections cannot desync). In the
appear-sentinel retry loop (where `pump_until_text` for `target["appear"]`
returns False), before spending the next retry/timeout, check
`_on_screen(screen, target["appear_nosub"])` — if the no-sub breakdown is
already on screen, break out of the retry loop immediately and snapshot
(the parser will classify it). Must NOT regress the subscribed path: only bail
when the primary `appear` sentinel did not match AND the no-sub sentinel did.

**3. `daemon.py` — envelope writes (three branches + new no-sub branch).**
Define a single helper or shared dict-builder so all variants emit the SAME
top-level keys: `schema_version: 1`, `id`, `target`, `multiplier`, `status`,
`subscription_active`, `last_successful_fetch_at`, `last_skipped_fetch_at`,
`last_failed_fetch_at`, `next_fetch_at`, `usage`, `error` (null where N/A).
- Import `NoActiveSubscription`. Wrap the `usage = parser(rendered)` call so
  `NoActiveSubscription` is caught as a SUCCESS: `usage=None`,
  `subscription_active=False`, `status="active"`, reset `consecutive_failures
  = 0`, `error_path.unlink(missing_ok=True)`, write the success-shaped
  envelope. (Re-raise other exceptions with the existing `screen_excerpt`
  attach.)
- Normal success: `status="active"`, `subscription_active = (True if target
  == "claude" else None)` — codex has no subscription concept, always `null`.
  The success branch OVERWRITES subscription_active fresh (so an upgraded
  account flips false→true cleanly); it does not merge it from prior.
- Idle-skip branch: stamp `status="idle"`, preserve `subscription_active`,
  `usage`, `last_successful_fetch_at`, `last_failed_fetch_at` from prior via
  the existing `prior.update(...)` merge. Additionally gate the idle-skip so
  it does NOT fire when `prior.get("status") == "stale"` — a failed account
  keeps attempting recovery during quiet periods instead of having its failure
  repainted as benign idle.
- Failure branch: in addition to the existing verbose `<id>.error.json`
  (keep `screen_excerpt` there), now ALSO `write_atomic` the main `<id>.json`:
  load prior, set `status="stale"`, `last_failed_fetch_at=failed_at`,
  `next_fetch_at`, and a concise `error = {"type", "message", "at"}` (NO
  screen_excerpt in the main envelope). Preserve last-good `usage`,
  `subscription_active`, and `last_successful_fetch_at` from prior. On a
  first-ever failure with no prior, `usage` and `last_successful_fetch_at` are
  `null`. Use `write_atomic` and `_load_envelope`.
- events.jsonl: the `scraped` event gains `subscription_active`; a no-sub read
  emits a `scraped` event with `usage: null` and `subscription_active: false`.
  Keep `idle_skipped` and `scrape_failed` as-is.

**4. `scrape_one.py` — sync the debug envelope.** Update the hand-built
envelope dict to mirror the daemon's new key set, and catch
`NoActiveSubscription` to print the no-sub envelope shape instead of dumping
the raw screen — it's the tool a client dev runs to inspect the format, so it
must not drift.

**5. Minimal regression test.** Add `pytest` to `pyproject.toml` dev deps and
a `tests/test_parse_claude_usage.py` with two fixtures: a captured no-sub
screen (breakdown, no bars → asserts `NoActiveSubscription`) and a subscribed
screen (bars → asserts the parsed session/week dict). This guards the
load-bearing detection against silent regression. Keep it lightweight — one
file, the parser's existing `now=` injection makes it deterministic.

### Investigation targets

**Required** (read before coding):
- parse_claude_usage.py:12-26 — `ClaudeUsageParseError`, `PANEL_HEADER`,
  `PERCENT_RE`; :84-148 — `_find_block`, `_parse_block`, `parse()` entry
- daemon.py:142-181 — `write_atomic`, `_load_envelope`, `_append_event`
  (reuse, do not hand-roll)
- daemon.py:309-356 — idle-skip branch (gate + `prior.update` merge)
- daemon.py:373-408 — success path (parser call + success envelope)
- daemon.py:415-455 — failure path (writes only error.json today)
- scrape.py:44-62 — `TARGETS["claude"]`; :158 — `_on_screen`; :171-183 —
  `pump_until_text`; :265-305 — appear-sentinel retry loop (warning ~274-278)

**Optional** (reference as needed):
- scrape_one.py:64-74 — divergent hand-built envelope to sync
- parse_codex_status.py — confirms codex returns session/week only (no sub)
- pyproject.toml — `[tool.uv] package = false`, flat layout, no test config yet

### Risks

- **scrape.py ↔ parser desync** (highest risk): the short-circuit sentinel and
  the parser's no-sub branch MUST key on the same string. Use one shared
  literal (`"% of usage"`) and verify both a subscribed and the no-sub account
  after wiring.
- **Premature snapshot**: the no-sub bail must only fire when the primary
  `appear` bar did NOT match — a subscribed panel mid-render must never trip it
  (bars paint above the breakdown; the appear-sentinel wait already covers
  subscribed accounts).
- **Idle masking stale**: verify the `prior.status != "stale"` gate so a broken
  account isn't silently flipped to idle.

### Test notes

Beyond the pytest fixture: run `uv run python scrape_one.py multi-claude-1`
(expect fast clean no-sub envelope) and `uv run python scrape_one.py default`
(expect real usage) against the live daemon-free path. Note these contend with
a running daemon — stop it or accept the known TUI contention.

## Acceptance

- [ ] `NoActiveSubscription` raised for the no-sub screen; subscribed screen
  still parses to session/week (+ optional sonnet_week) unchanged
- [ ] Daemon writes a no-sub `<id>.json` (`subscription_active: false`,
  `usage: null`, `status: "active"`, error file cleared, failures reset)
- [ ] Failure stamps main `<id>.json` (`status: "stale"`, concise `error`, no
  screen_excerpt, last-good usage preserved) AND keeps verbose error.json
- [ ] Idle-skip sets `status: "idle"`, preserves subscription/usage, and does
  not fire when prior status is `stale`
- [ ] All variants emit the uniform key set incl `schema_version: 1`;
  `subscription_active` is `null` for codex
- [ ] scrape.py no-sub bail keyed on the same sentinel as the parser; no
  regression to subscribed scrape timing
- [ ] scrape_one.py prints the new envelope shape (incl no-sub case)
- [ ] `uv run pytest -q` passes

## Done summary

## Evidence
