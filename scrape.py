"""Drive a TUI through a PTY, scrape a screen, and return rendered text.

Public API:
    scrape(target_name: str, passthrough_args: list[str]) -> str

Targets:
    claude   spawn `claude`, navigate to /usage, scrape the panel
    codex    spawn `codex`,  navigate to /status, scrape the panel
"""

import sys
import time

import pexpect
import pyte

COLS, ROWS = 300, 100
QUIET_SECONDS = 0.6
SENTINEL_TIMEOUT = 15.0

# Plan tier source-of-truth (was dump_plans.py:13-17 before task 1 demolition).
# `~/.claude-profiles/<p>/.claude.json:oauthAccount.organizationRateLimitTier`
# maps as: default_claude_ai -> Pro (1x), default_claude_max_5x -> Max (5x),
# default_claude_max_20x -> Max (20x). Codex has no tier field; treat as 1x.


# ---------- Target definitions ---------------------------------------------

# Each target says: which binary to spawn, which slash command to type, and
# (optionally) sentinels for "panel opened" and "panel finished loading".
# Sentinels are strings that must appear somewhere in the rendered screen.
TARGETS = {
    "claude": {
        # Use the arthack-claude wrapper directly so flags like
        # --arthack-profile work (the shell alias isn't visible to pexpect).
        "command": "/Users/mike/.local/bin/arthack-claude.py",
        "slash": "/usage",
        # Wrappers do extra setup (auth, profile, plugin sync) — give it room
        # so our slash-command keystrokes don't land before the TUI is ready.
        "ready_wait": 2.0,
        # /usage shows "Scanning local sessions…" while it computes the
        # breakdown, then that line disappears once the scan completes.
        "appear": "Scanning local sessions",
        "gone": "Scanning local sessions",
    },
    "codex": {
        "command": "/Users/mike/.local/bin/arthack-codex.py",
        "slash": "/status",
        "ready_wait": 2.5,
        # /status has no scan phase — the panel paints once and stays. Use a
        # row that only appears after the panel renders.
        "appear": "5h limit",
        "gone": None,
    },
}


# ---------- PTY / pyte helpers ---------------------------------------------


def _on_screen(screen, needle):
    return any(needle in line for line in screen.display)


def pump_until_idle(child, stream, quiet_seconds=QUIET_SECONDS):
    while True:
        try:
            chunk = child.read_nonblocking(size=8192, timeout=quiet_seconds)
            stream.feed(chunk)
        except (pexpect.TIMEOUT, pexpect.EOF):
            return


def pump_until_text(child, screen, stream, needle, max_seconds=SENTINEL_TIMEOUT):
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        if _on_screen(screen, needle):
            return True
        try:
            chunk = child.read_nonblocking(size=8192, timeout=0.2)
            stream.feed(chunk)
        except (pexpect.TIMEOUT, pexpect.EOF):
            continue
    return _on_screen(screen, needle)


def pump_while_text(child, screen, stream, needle, max_seconds=SENTINEL_TIMEOUT):
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        if not _on_screen(screen, needle):
            return True
        try:
            chunk = child.read_nonblocking(size=8192, timeout=0.2)
            stream.feed(chunk)
        except (pexpect.TIMEOUT, pexpect.EOF):
            continue
    return not _on_screen(screen, needle)


# ---------- Core scrape flow -----------------------------------------------


def scrape(target_name: str, passthrough_args: list[str]) -> str:
    target = TARGETS[target_name]

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    child = pexpect.spawn(
        target["command"],
        args=passthrough_args,
        dimensions=(ROWS, COLS),
        encoding=None,
        timeout=10,
    )

    try:
        pump_until_idle(
            child, stream, quiet_seconds=target.get("ready_wait", QUIET_SECONDS)
        )

        child.send(target["slash"])
        pump_until_idle(child, stream)

        child.send("\r")

        if target["appear"]:
            if not pump_until_text(child, screen, stream, target["appear"]):
                print(
                    f"warning: sentinel {target['appear']!r} never appeared",
                    file=sys.stderr,
                )
        if target["gone"]:
            if not pump_while_text(child, screen, stream, target["gone"]):
                print(
                    f"warning: sentinel {target['gone']!r} never cleared",
                    file=sys.stderr,
                )
        if not target["appear"] and not target["gone"]:
            # No sentinels known yet — fall back to a generous idle window.
            pump_until_idle(child, stream, quiet_seconds=4.0)

        return "\n".join(line.rstrip() for line in screen.display)
    finally:
        child.sendcontrol("c")
        child.sendcontrol("c")
        try:
            child.expect(pexpect.EOF, timeout=5)
        except pexpect.TIMEOUT:
            child.terminate(force=True)
