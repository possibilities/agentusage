# 0001 — tmux capture driver for the Bun scrape core

- Status: accepted (spike GO). Date: 2026-07-06. Deciders: fn-9 epic.
- Host: macOS 25.5 arm64, tmux `next-3.8`, bun `1.3.14`, `@js-temporal/polyfill` `0.5.1`.

## Context

The Bun port replaces `scrape.py`'s pexpect+pyte PTY layer, unusable under Bun
(node-pty `onData` dead #25822/#29112; `Bun.Terminal` PTY-alloc fails post
sleep/wake #25912 — disqualifying under a LaunchAgent; no controlling tty
#33237). Primary: a **tmux driver on `-L agentusage-scrape`** (tmux owns
pty+VT100+reaping in C; Bun shells out and reads `capture-pane`). Pre-approved
fallback if gates (1)-(3) diverged: bun-pty + @xterm/headless (not needed).

## Decision — GO (tmux driver; fallback not consumed)

All de-risk gates passed on the corpus AND a live claude scrape. Driver MUST:

- **Server:** dedicated `tmux -L agentusage-scrape`.
- **TERM (load-bearing):** generate a one-line `set -g default-terminal
  "xterm-256color"` and pass via `-f <conf>`. tmux **ignores `-e TERM`** (forces
  pane TERM from `default-terminal`); `set-option` post-`start-server` is too
  late (a session-less server exits). Config must precede `new-session`.
- **Spawn:** `new-session -d -s <n> -x <cols> -y <rows> -c <tmpdir> -e
  CLAUDE_CONFIG_DIR=<p> -e LINES=<rows> -e COLUMNS=<cols> <cmd>` (`-e` injects
  everything except TERM).
- **Per-session scoping (`-t <n>`, never `-g` — shared server):** `set-option -t
  <n> status off`, `set-option -t <n> escape-time 0`.
- **Alt gate:** `display-message -p -t <n> '#{alternate_on}'` == 1 (replaces
  pyte's alt-screen gate before the signed-out quorum).
- **Capture:** `capture-pane -p -J -t <n>` (never `-a`).
- **Slash:** three `send-keys` — `C-u`, then `-l '<slash>'` (literal), `Enter`.
- **Idle:** 3 identical 0.2s `capture-pane -pJ` snapshots = settled; deadline-bounded.
- **Cleanup:** `send-keys C-c` ×2, then `kill-session`.

## Spike evidence

Reference = pyte over `b"\x1b[?1049h"+transcript`, `"\n".join(rstrip rows)`;
compared rstrip-per-row + trailing-blank-trim. Scratch harnesses not shipped.

1. **TERM** — `-f /dev/null` default is `tmux-256color` (host-dependent, NOT the
   assumed screen-family — set it explicitly). `-e TERM=xterm-256color` ignored
   (child saw `tmux-256color`; sibling `-e FOO=bar` passed). `-f` config with
   `default-terminal xterm-256color` → child sees `xterm-256color`. Confirmed
   live on all 3 accounts. Min-version `next-3.8` has every needed surface.
2. **Capture-text incl wrap-split** — 13/14 corpus cases byte-identical to pyte.
   `claude-wrap-split-signed-out` (30×24) differs favorably: `-J` REJOINS the
   wrapped URL (pyte splits `…/oauth/` + `authorize?code=1`; `-J` yields one
   line), so `/oauth/authorize` lands intact and the 2-of-3 signed-out quorum
   holds without a dewrap step.
3. **alternate_on** — 1 on `\x1b[?1049h` (fake + every corpus case + 3 live TUIs); 0 on a plain shell.
4. **Snapshot-idle** — stable: settled 0.46s/3 snaps. settle (spin 4s then
   clear): busy 21 snaps, settled 4.44s post-clear. forever (never clears):
   deadline 8.02s/36 snaps, never converged — deadline is load-bearing.
5. **Geometry** — `-x 300 -y 200` → window & pane 300×200; a detached pane fills
   the window (status steals no row). Live 300-col panel: no truncation/wrap.
6. **Env injection** — `-e LINES/COLUMNS/FOO` all reach the child (only TERM
   overridden). Live `-e CLAUDE_CONFIG_DIR` selected each profile.
7. **Temporal bracket-suffix** — accepted WITHOUT `!`:
   `bun -e 'import {Temporal} from "@js-temporal/polyfill"; console.log(Temporal.ZonedDateTime.from("2026-05-29T12:00:00-04:00[America/New_York]").toString())'`
   → `2026-05-29T12:00:00-04:00[America/New_York]`. `!` optional/identical. Also:
   `toString({smallestUnit:'second'})` strips fractions; unknown zone and
   offset≠zone both throw RangeError (default reject); `disambiguation:
   'compatible'` = Python fold=0. (bun 1.3.14 has no native Temporal.)

**Live scrape (mandatory):** real `claude 2.1.201` at 300×200 under
`xterm-256color`, `/private/tmp` pre-trusted, `/usage` via the send-keys shape —
all three arms captured with `alternate_on=1`: the Max account matched `Current
week (all models)` (full bars, `█`/`▌` faithful); Pro hit the
endpoint-rate-limited arm; the API-billing org hit the no-bars arm. Live drift
(for the parser task, not this spike): the optional bar rendered as `Current week
(Fable)`, not the corpus's `Current week (Sonnet only)` — the `appear_optional`
sentinel would miss it.

## References

Consumer `keeper/src/usage-scrape-runner.ts:249-353`; port surface `scrape.py`
(:282-312, :315-375, :51-122), `tests/fixtures/corpus/`, `tests/fake_tui.py`;
tmux precedent `keeper/src/exec-backend.ts:365-626`. Bun issues cited inline.
