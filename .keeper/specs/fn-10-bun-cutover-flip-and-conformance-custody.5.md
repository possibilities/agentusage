## Description

**Size:** S
**Files:** scripts/soak-report.ts, tests/corpus_schema.md

### Approach

Build the evidence surface the post-landing operator phase reads. `scripts/soak-report.ts` (agentusage repo — it reads this util's state surface) ingests ~/.local/state/agentusage/<id>.json envelopes plus events.jsonl and renders a per-profile report: scrape counts and success rate by arm, error_kind histogram, latency distribution vs the 60s budget, last-N-cycle streaks, and an orphaned-tmux check (servers/sockets on the agentusage-scrape socket with no live scrape). It takes a --since window and a --baseline window so the operator can compare the bun soak against the trailing uv baseline without live double-execution. Append the soak runbook to the epic knowledge surface as a short operator section in tests/corpus_schema.md's sibling doc space or the epic spec itself: flip = set usage_scraper_runtime=bun as a config override (default stays uv; rollback = clear it), soak through the LaunchAgent (not a shell) across ≥1 real sleep/wake, exit criteria = N consecutive clean cycles per profile + zero contract regressions vs baseline + no orphaned servers + latency within budget, StandardOutPath redirection only during the window (usage JSON is account-identifying).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- ~/code/keeper/src/usage-scraper-worker.ts — envelope field semantics (status/error/last_*_fetch_at) and events.jsonl event shapes the report parses
- README.md envelope/decision-matrix sections — the human-facing field meanings to mirror in report labels

**Optional** (reference as needed):
- docs/adr/0001-tmux-scrape-driver.md — the sweep/socket naming the orphan check inspects

### Risks

- The report must never trigger scrapes or write state — read-only over the state dir, or it becomes part of the system it measures.

### Test notes

Run against the live state dir on this box (uv-produced envelopes) and confirm sensible output today, before any flip exists.

## Acceptance

- [ ] soak-report renders per-profile success/arm/error-kind/latency/streak evidence plus the orphaned-tmux check from real current envelopes, read-only
- [ ] --since/--baseline windows produce a uv-vs-bun comparable report shape
- [ ] The runbook states flip mechanism (override, default uv), rollback (clear the override), launchd requirement, sleep/wake requirement, privacy note, and the numeric exit criteria

## Done summary

## Evidence
