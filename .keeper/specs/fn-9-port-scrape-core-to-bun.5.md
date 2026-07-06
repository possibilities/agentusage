## Description

**Size:** M
**Files:** src/scrape.ts, docs/adr/0001-tmux-scrape-driver.md

### Approach

Port `scrape()` onto the stack the spike verdict names (tmux driver expected; if the ADR says fallback, implement bun-pty + @xterm/headless behind the same module surface — the exported API is identical either way). Dedicated named server per the mandate: `tmux -L agentusage-scrape` with the spike's config strategy; one uniquely-named session per scrape (`<target>-<profile>-<pid>-<monotonic>`, sanitized to tmux-legal chars); pre-scrape sweep kills sessions on this server older than 180s (3x keeper's 60s budget — only true leaks from SIGKILLed scrapes qualify); all options session-scoped (`escape-time 0`, `status off`), never `-g`. Spawn shape mirrors Python: `-x 300 -y 200` (or --rows/--cols overrides), `-c <mkdtemp sandbox>` with symlinks resolved, env injection TERM/LINES/COLUMNS, CLAUDE_CONFIG_DIR from profile extraction, PATH prepend for absolute commands. Port verbatim: the TARGETS table with every timing value and its rationale comment; the sentinel state machine (ready-wait, pre-send signed-out 2-of-3 quorum gated on `#{alternate_on}`, SLASH_RETRIES=2 over [appear, appear_nosub, appear_error] with short-circuits, appear_settle, best-effort appear_optional + 1.0s settle, gone clear, idle fallback, final snapshot join); the snapshot-idle primitive (quiet = 3 consecutive identical `capture-pane -pJ` at 0.2s; deadlines stay wall-clock); dewrap matching over the joined capture; keystrokes as separate send-keys calls (`C-u`, `-l <slash>`, `Enter`); `#{pane_dead}` as the EIO-equivalent closed-output signal; trust-file pre-marking (claude .claude.json isTrusted+hasTrustDialogAccepted on the /private/tmp parent; codex idempotent TOML stanza append); `_resolve_codex_command` with its exact candidate ordering and AGENTUSAGE_CODEX_COMMAND escape hatch; cleanup = kill-session (+ the sweep next run as the leak backstop). Up-front probe: tmux binary missing or version-parse clearly below 3.2 yields a typed driver error the CLI maps to the scrape_failed arm (lenient parse — odd strings like next-3.8 pass). SignedOut is a typed result the CLI turns into its arm. Finalize the ADR from draft to accepted with the implemented invocation shape.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scrape.py — full file; this task is its 1:1 port, and the inline rationale comments are part of the port surface
- docs/adr/0001 draft — the spike's verdict, TERM/config strategy, and invocation shape are binding inputs
- ~/code/keeper/src/exec-backend.ts:365-626 — tmux argv construction house style over Bun.spawn

**Optional** (reference as needed):
- tests/test_scrape_helpers.py — the fake-child state-machine cases documenting expected branch behavior (Epic B translates them; here they are the behavior spec)
- src/parse-claude-usage.ts — import the shared sentinel literals; do not redeclare

### Risks

- The quiet-window-to-snapshot mapping is the subtlest behavioral shift; the spinner corpus case plus the dual-run harness (task 7) are its guards — do not tune constants away from the ported values without corpus evidence.
- Concurrent scrapes share the named server: any global (-g) option write or an over-aggressive sweep threshold breaks a sibling scrape; both invariants are spec-level, not stylistic.

### Test notes

Developable against the fake TUI: `bun src/scrape.ts` behind a thin debug entry or via the task-6 CLI once it lands; the real gate is task 7's dual-run. Manual check: SIGKILL a mid-scrape driver, run a second scrape, confirm the leaked session dies by sweep and the TUI grandchild is gone.

## Acceptance

- [ ] Driving the fake TUI subscribed scenario through the driver returns rendered text whose parse yields the expected contract JSON (via the task-6 CLI or a debug entry)
- [ ] A scrape leaves zero sessions on the agentusage-scrape server afterward; a deliberately SIGKILLed scrape's leaked session is reaped by the next scrape's sweep while a concurrent fresh session survives
- [ ] Signed-out corpus scenario short-circuits pre-send (fake TUI receives no slash keystrokes) gated on alternate_on
- [ ] Missing tmux binary produces the typed driver error (observable as the CLI's scrape_failed arm), not a crash trace on stdout
- [ ] docs/adr/0001 is finalized (status accepted, exercised path recorded)

## Done summary
Ported scrape() onto a tmux driver (tmux -L agentusage-scrape) in src/scrape.ts: sentinel state machine, trust pre-marking, codex-command resolution, snapshot-idle, leak sweep, tmux probe, and #{pane_dead} closed-output signal. Verified against the fake TUI (subscribed parses to the expected contract, signed-out short-circuits pre-send, missing tmux yields the typed error, sweep reaps a SIGKILL leak while a fresh session survives). Finalized ADR 0001.
## Evidence
