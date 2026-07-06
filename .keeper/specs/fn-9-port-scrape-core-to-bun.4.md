## Description

**Size:** M
**Files:** docs/adr/0001-tmux-scrape-driver.md, scratch spike scripts (not shipped)

### Approach

De-risk the tmux driver on this box before the driver is written; produce a go/no-go verdict and the ADR draft. Validate, against corpus replays through the fake TUI on a dedicated `-L agentusage-scrape-spike` server AND one live claude scrape: (1) TERM strategy — with `-f /dev/null`, default-terminal is screen-family; determine whether the Ink panels render identically to the pyte corpus under it, else pick the fix (a generated one-line config setting `default-terminal xterm-256color`, or session-scoped set-option timing) and record which; (2) `capture-pane -pJ` text equals the pyte-rendered corpus text for the same transcripts, including the narrow-cols wrap-split case (join semantics vs full-width fill); (3) `#{alternate_on}` flips on the fake TUI's `\x1b[?1049h` and on the real TUI, and reads 0 on a non-alt shell — the signed-out gate's replacement signal; (4) the snapshot-idle primitive (3 identical 0.2s captures) goes quiet on stable panels and does NOT hang on the spinner fixture; (5) `-x 300 -y 200` geometry renders without Ink truncation/pagination; (6) `new-session -e` env injection reaches the child (TERM/LINES/COLUMNS); (7) one-liner: Temporal polyfill accepts a bracket-suffixed ISO without a `!` critical flag. Timebox: if (1)-(3) diverge irreparably, the verdict is the pre-approved fallback (bun-pty + @xterm/headless) — no check-in needed; write the ADR draft either way with evidence captures inline.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scrape.py:276-312 — the alt-screen gate + dewrap the tmux signals must reproduce
- scrape.py:315-375 — the pump/quiet-window semantics the snapshot-idle primitive replaces
- tests/fixtures/corpus/ — the transcripts and structural cases (task 3's output)
- tests/fake_tui.py — replay mechanics

**Optional** (reference as needed):
- ~/code/keeper/src/exec-backend.ts:365-626 — keeper's tmux argv construction patterns (house precedent for building tmux commands)

### Risks

- This box runs tmux next-3.8; note any version-sensitive behavior (capture flags, format vars, `-e` support) in the ADR so the driver's min-version probe has evidence.
- A spike that only tests the fake TUI can miss real-Ink repaint behavior — the one live claude scrape is mandatory, not optional.

### Test notes

Spike evidence (capture diffs, alternate_on transcripts, timing logs) goes into the ADR draft and the Done summary; scratch scripts stay out of the commit or land clearly-marked under a spike/ dir if worth keeping.

## Acceptance

- [ ] docs/adr/0001 draft exists (MADR shape) recording context, decision (tmux driver or exercised fallback), and per-check evidence for TERM strategy, capture-text equivalence incl. wrap-split, alternate_on behavior, snapshot-idle on the spinner case, geometry, and env injection
- [ ] A clear go/no-go verdict names the stack the driver task must implement and the exact tmux invocation shape (config strategy, option scoping) it must use
- [ ] The Temporal bracket-suffix question is answered with a one-line reproducible check

## Done summary
Spike verdict GO: tmux driver on -L agentusage-scrape. ADR 0001 records the exact invocation shape (default-terminal via -f config since -e TERM is ignored; per-session status/escape-time scoping) and per-check evidence — TERM strategy, capture-text equivalence (13/14 corpus byte-identical; wrap-split rejoined favorably by -J), alternate_on flip, snapshot-idle (settles on stable, deadline-bounded on live spinner), 300x200 geometry, -e env injection, Temporal bracket-suffix accepted without ! — plus a live claude scrape across all three arms (subscribed bars, rate-limited, no-subscription).
## Evidence
