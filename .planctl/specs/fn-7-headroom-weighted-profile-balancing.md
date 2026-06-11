## Overview

`pick_profile()` in `agentuse/api.py` is a deliberately dumb v1: least-recently-picked round-robin over subscribed claude profiles, explicitly ignoring multiplier and usage. v2 makes it a balancer: effective weight = multiplier × session headroom, where headroom = clamp(1 − `usage.session.percent_used`/100, 0, 1), and the pick is credit-based — the eligible profile minimizing `count / effective_weight` (stride scheduling). A Max-5x account absorbs ~5× the picks of a Pro account at equal headroom, and a profile whose session window fills up sheds load automatically — quota burn is the feedback signal. SESSION WINDOW ONLY by deliberate, human-confirmed v1 scope: no weekly term, no time-to-reset (quota-left beats time-left because quota is the binding constraint and the feedback loop self-corrects). All existing fail-open guarantees hold verbatim: never raise, `"default"` on any failure.

Depends on fn-6-per-cycle-multiplier-refresh: weighting by multiplier is wrong while envelopes carry stale boot-time multipliers (a 20x profile currently reports 1x).

## Quick commands

- `uv run pytest tests/test_picker.py` — full picker suite incl. new proportionality/headroom/fallback tests
- `uv run python -c "from agentuse.api import pick_profile; print(pick_profile())"` — live pick against real envelopes

## Acceptance

- [ ] At equal headroom, a 5x profile is picked ~5× as often as a 1x profile (ratio tolerance over large N)
- [ ] Headroom scales the multiplier: a 10x profile at 50% session used balances evenly against a 5x at 0%
- [ ] All-zero weights fall back to multiplier-only credit ordering; all other fail-open paths (missing envelope, corrupt state, no eligible) still return "default" or a valid profile, never raise
- [ ] Existing equal-weight behavior degenerates to round-robin (current distribution test stays green)

## Early proof point

Task that proves the approach: ordinal 1 (the only task). If it fails: fall back to weighted-random selection proportional to effective weight — simpler, loses determinism, keeps proportionality in expectation.

## References

- Waldspurger & Weihl, Stride Scheduling (MIT TR-667, 1995) — the min(count/weight) selection rule; dynamic weights and new-entrant initialization covered in §3/§5
- LVS Weighted Least-Connection docs — zero-weight exclusion; cross-multiply comparison to avoid float division
- fn-6-per-cycle-multiplier-refresh — provides trustworthy envelope multipliers; hard dependency

## Docs gaps

- **README.md** (Python API section, lines ~38-48): remove "multiplier intentionally ignored — round-robin, not balancing"; describe weighted balancing — handled inside the task
- **README.md** (Worked balancing example, lines ~319-350): formula currently uses `week.percent_used`; revise in place to the session-only formula — handled inside the task
- **README.md** (routing rule short-form, lines ~312-317): keep step 3 consistent with the revised worked example — handled inside the task

## Best practices

- **Stride scheduling, not nginx smooth-WRR:** SWRR's current_weight state goes stale under dynamic weights; min(count/weight) handles per-cycle weight changes naturally [Waldspurger TR-667; smallnest/weighted caveats]
- **New-entrant init to min(existing counts), not 0:** zero-init gives a fresh profile a catch-up burst of consecutive picks [stride scheduling canon]
- **Never reset counts on weight change:** erasing accrued service history corrupts fairness and transiently starves existing profiles
- **Clamp headroom to [0,1] and floor tiny weights (<1e-9 → 0):** defends against corrupt percent_used and float-division blowups
