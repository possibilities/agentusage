## Description

**Size:** M
**Files:** agentuse/api.py, tests/test_picker.py, README.md

### Approach

Replace `_choose`'s least-recently-picked rule with credit-based weighted selection while keeping the surrounding machinery (config read, envelope read, fcntl lock, atomic write, fail-open wrapper) untouched.

Weight: `effective_weight = multiplier × clamp(1 − session_percent/100, 0.0, 1.0)`. `multiplier` comes from the profile's envelope; coerce defensively — non-int or < 1 → treat as 1 (the daemon only writes {1,5,20}, but the envelope is external input). `session_percent` is `usage.session.percent_used`; a missing `usage`, missing `session`, or missing/non-numeric `percent_used` → full headroom (1.0) — note the nesting is exactly `usage["session"]["percent_used"]`; a flat read would silently always yield full headroom and mask bugs. Floor: weight < 1e-9 → treat as exactly 0.

Eligibility: `_eligible_profiles` changes from `list[str]` to returning name→envelope pairs (e.g. `list[tuple[str, dict]]`) so weights are computed from the same single read — update both call sites in `_pick_profile`. The existing filters (target claude, subscription_active is True, rate-limit cooldown with the include_rate_limited two-pass) are preserved exactly; envelope reads stay OUTSIDE the lock (the lock guards only the picker.json read-modify-write, as today).

Selection, inside the lock: among eligible profiles with weight > 0, pick min by `(count / weight, name)` — name tie-break keeps it deterministic. A profile with no `count` entry in picker.json compares as `min(existing counts)` (0 when the state is empty) — the stride-scheduling new-entrant rule; do not write that synthetic count back, `_record_pick`'s normal increment handles it. If EVERY eligible profile's weight is 0 (all sessions fully burned), re-run the same credit rule with weight = multiplier alone (headroom factor dropped) — one mechanism, one degenerate form. Counts are never reset when weights change. `_record_pick` keeps stamping `last_picked_at` (observability only — it no longer drives choice) and incrementing `count`. `PICKER_SCHEMA_VERSION` stays 1: the `count` field's shape is unchanged, old round-robin-era counts are valid credits.

Fail-open invariants verbatim: `pick_profile` never raises; any failure returns `"default"`; empty eligible set falls through the existing include_rate_limited pass before defaulting.

Docs in the same commit: module docstring (api.py:14-29) and `pick_profile` docstring (:82-100) describe the weighted scheme; README Python API section, worked balancing example (week → session formula, revise in place, don't expand), and routing short-form step 3 made consistent.

### Investigation targets

**Required** (read before coding):
- agentuse/api.py:117-135 — `_pick_profile`: both `_eligible_profiles` call sites and the lock scope
- agentuse/api.py:162-187 — `_eligible_profiles`: filters to preserve; return-shape change
- agentuse/api.py:190-227 — `_choose` / `_pick_sort_key` / `_record_pick`: the replacement site and the count ledger
- tests/test_picker.py:33-93 — harness: `state_dir` fixture, `_write_config`, `_write_envelope` (extend signature with `multiplier` and `session_percent` params, nesting `usage.session.percent_used` correctly), `_counts`, `_MonotonicClock`
- tests/test_picker.py:208-226 — `test_concurrent_picks_distribute_evenly` asserts max-min ≤ 1: must STAY GREEN — equal weights must degenerate to round-robin

**Optional** (reference as needed):
- parse_claude_usage.py:165-184 — producer of the `usage.session` shape ({percent_used, resets_at})
- agentuse/api.py:138-159 — `_is_rate_limited_now`: reuse, don't reinvent
- README.md lines ~38-48, ~312-350 — doc surfaces to update

### Risks

- The equal-weight degenerate case must reproduce round-robin or the existing distribution test breaks — if tie-break ordering changes the spread, fix the algorithm, not the test.
- Proportionality assertions are statistical: assert ratio within tolerance over large N (e.g. 600 picks, 5x:1x ratio in [4.5, 5.5]), using `_MonotonicClock` to kill timestamp ties.
- Reading weights from a stale envelope (status == "stale" still rotates, v1 rule) means balancing on last-good headroom — accepted, do not add a stale filter.

### Test notes

New tests in tests/test_picker.py:
- Proportionality: 5x and 1x at full headroom, N picks → ratio ≈ 5 within tolerance.
- Headroom scaling: 10x at 50% used vs 5x at 0% → even split.
- All-zero fallback: every profile at 100% used → picks still distribute by multiplier credit, never raises.
- Missing usage / missing session / missing percent_used → full headroom.
- New-entrant: established counts in picker.json, add a fresh profile → no catch-up burst (its first-pick credit is min, not 0).
- Defensive: percent_used > 100 clamps to 0 headroom; multiplier 0/negative/garbage treated as 1.
- Existing suite green, especially test_concurrent_picks_distribute_evenly.

## Acceptance

- [ ] Pick rule is min(count / (multiplier × session headroom)) with name tie-break; deterministic
- [ ] 5x picked ~5× as often as 1x at equal headroom (tolerance test)
- [ ] 10x at 50% used balances evenly against 5x at 0% used
- [ ] All-zero weights degrade to multiplier-only credit ordering; never raises; "default" preserved on failure paths
- [ ] New-entrant min-count rule prevents catch-up bursts
- [ ] Existing tests green including the equal-weight distribution test; PICKER_SCHEMA_VERSION unchanged
- [ ] api.py docstrings + README (Python API, worked example session formula, routing short-form) updated
- [ ] `uv run pytest` green

## Done summary

## Evidence
