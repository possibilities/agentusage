## Overview

The agentuse daemon scrapes Claude/Codex usage panels and writes per-account
JSON envelopes to `~/.local/state/agentuse/<id>.json`, consumed by an external
client for profile balancing (routing work to accounts with quota). Today the
envelope can't express three real states: an account with **no active
subscription** (currently misclassified as a scrape error — `multi-claude-1`
only ever produces `<id>.error.json`, never a main file), data that is **stale**
because the last fetch failed (the failure only touches the sidecar error file,
so a single-file reader sees old `usage` with no signal), and **idle** (skipped
for inactivity — only implicit via timestamps today).

End state: two orthogonal axes on every envelope — `status` ∈ {active, idle,
stale} (freshness/liveness) and `subscription_active` ∈ {true, false, null}
(plan) — plus a `schema_version`, a uniform key set across all variants, a
short-circuit that stops no-sub scrapes from burning ~180s, and a README that
documents the full contract for client developers.

Client decision rule the format must support: **skip if
`subscription_active == false`; distrust `usage` if `status == "stale"`;
otherwise use `usage`.**

## Quick commands

- `uv run python scrape_one.py multi-claude-1` — should print a clean
  `subscription_active: false`, `status: "active"`, `usage: null` envelope (no
  parse error, fast — not ~180s)
- `uv run python scrape_one.py default` — should print a normal subscribed
  envelope with `subscription_active: true` and populated `usage`
- `cat ~/.local/state/agentuse/multi-claude-1.json` — after a daemon cycle,
  shows the no-subscription envelope
- `uv run pytest -q` — parser no-sub regression test passes

## Acceptance

- [ ] No-subscription claude accounts produce a main `<id>.json` with
  `subscription_active: false`, `usage: null`, `status: "active"` — not an error
- [ ] A failed scrape stamps the main `<id>.json` with `status: "stale"` + a
  concise `error` object while preserving last-good `usage`, in addition to the
  verbose `<id>.error.json`
- [ ] Idle-skip stamps `status: "idle"` and never overwrites a `stale` status
- [ ] Every envelope variant carries the same top-level keys (incl
  `schema_version`) with `null` where N/A
- [ ] No-sub scrapes no longer burn the full ~180s sentinel timeout; subscribed
  scrapes are unaffected
- [ ] README documents every field, the claude vs codex `usage` shapes, the
  error/events formats, and the status × subscription_active decision matrix

## Early proof point

Task that proves the approach: `<task .1>`. The keystone is the
`NoActiveSubscription` detection shared between `parse_claude_usage.py` and
`scrape.py` — if `scrape_one.py multi-claude-1` returns a clean no-sub envelope
quickly and `scrape_one.py default` still returns real usage, the contract
holds. If it fails: the no-sub sentinel chosen is ambiguous — fall back to a
stricter positive marker (e.g. the literal breakdown question line) and
re-verify against both a subscribed and the no-sub account.

## References

- Investigation captured the live no-sub `/usage` panel: it renders a
  usage-contribution breakdown (`What's contributing to your limits usage?`,
  `% of usage`, `d to day · w to week`, `Esc to cancel`) with NO rate-limit bars
  (no `Current session` / `Current week` rows, no `% used`). Header tab casing
  also varies (`Usage` vs `usage`) between scrapes — the existing strict header
  gate is fragile and must be relaxed on the bars path.
- Practice guidance: stamp `status` at write time (not reader-derived); keep
  `screen_excerpt` out of the main envelope (debug artifact → error.json/events
  only); distinguish `subscription_active: null` (unknown) from `false`
  (confirmed inactive); clients must ignore unknown top-level fields.

## Docs gaps

- **README.md** (create): the primary deliverable — full data-format reference
  (see task .2).
- **daemon.py module docstring**: currently describes the envelope shape inline
  ("writes a self-stamped JSON envelope"); revise to point at README rather than
  duplicate the schema.
- **parse_claude_usage.py module docstring**: note the no-subscription case now
  that detection lives there.

## Snippet context

No snippets or bundles — `promptctl find-snippets` returned no coverage for this
repo's domain (atomic write, strict parser, json envelope, readme data format).
