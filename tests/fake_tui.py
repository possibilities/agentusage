#!/usr/bin/env python3
"""Scripted stand-in for the real claude/codex TUI, driven by a corpus case.

Both runtimes (the Python scrape CLI and, later, the Bun port) point their
``--command`` at this script so the conformance corpus replays byte-for-byte
against the SAME fake terminal. The case to replay is selected by the
``AGENTUSAGE_FAKE_CASE`` env var, an absolute path to a corpus case directory
holding ``case.json`` + ``transcript.ansi``.

Multi-modal, matching the two ways the scrape CLI invokes the target binary:

1. ``fake_tui.py auth status`` (any argv containing ``auth``) — prints
   ``{"loggedIn": <bool>}`` from the case's ``logged_in`` field and exits. This
   satisfies the CLI's no-bar auth probe (agentusage/scrape_cli.py).
2. otherwise — TUI mode. Enters the alternate screen, waits the case's mount
   delay, then EITHER replays immediately (``paint_on_boot`` cases, e.g. the
   OAuth sign-in screen the scraper classifies PRE-SEND) OR absorbs input until
   it sees the scraper's ctrl-U + ``/slash`` + CR clear-type-submit sequence and
   only THEN replays the transcript. The paint-on-slash gate is load-bearing:
   painting on boot would silently no-op the scraper's retry state machine.

Unknown argv (e.g. codex's ``--dangerously-bypass-approvals-and-sandbox``) is
tolerated and ignored. Stdlib-only so it runs under a bare interpreter.
"""

from __future__ import annotations

import json
import os
import select
import sys
import time
from pathlib import Path

# Absolute time budget for a single TUI invocation. The real scrape snapshots
# and reaps the child in well under this; the cap only exists so a misdriven
# fake can never wedge a test run.
_MAX_SESSION_SECONDS = 30.0

_ALT_SCREEN_ENTER = b"\x1b[?1049h"
_CTRL_C = 0x03
_CTRL_U = 0x15
_CR = 0x0D
_LF = 0x0A
_SLASH = ord("/")


def _load_case() -> tuple[dict, bytes]:
    case_dir = os.environ.get("AGENTUSAGE_FAKE_CASE")
    if not case_dir:
        sys.stderr.write("fake_tui: AGENTUSAGE_FAKE_CASE is unset\n")
        raise SystemExit(2)
    root = Path(case_dir)
    config = json.loads((root / "case.json").read_text())
    transcript = (root / "transcript.ansi").read_bytes()
    return config, transcript


def _run_auth_mode(config: dict) -> int:
    logged_in = config.get("logged_in")
    sys.stdout.write(json.dumps({"loggedIn": bool(logged_in)}) + "\n")
    sys.stdout.flush()
    return 0


def _wait_for_slash_submit(deadline: float) -> bool:
    """Absorb stdin until the scraper's ctrl-U, /slash, CR sequence arrives.

    Mirrors scrape.send_slash_command's exact bytes: ctrl-U (clear line), the
    literal slash command, then a carriage return. Returns True once a CR lands
    after a ctrl-U with a ``/`` in the buffer, False on EOF or timeout.
    """
    seen_ctrl_u = False
    buf = bytearray()
    while time.monotonic() < deadline:
        readable, _, _ = select.select([0], [], [], 0.2)
        if not readable:
            continue
        try:
            data = os.read(0, 4096)
        except OSError:
            return False
        if not data:
            return False
        for byte in data:
            if byte == _CTRL_U:
                seen_ctrl_u = True
                buf.clear()
            elif seen_ctrl_u and byte in (_CR, _LF):
                if _SLASH in buf:
                    return True
                seen_ctrl_u = False
                buf.clear()
            elif seen_ctrl_u:
                buf.append(byte)
    return False


def _drain_until_close(deadline: float) -> None:
    """Keep the pane alive (discarding input) until EOF or the deadline.

    The scraper snapshots the rendered screen and then reaps the process group;
    staying readable until then keeps the alt-screen buffer up, matching a real
    TUI that only exits on the ctrl-C the scraper's cleanup sends. Raw mode
    disables signal generation, so honor that ctrl-C explicitly for a prompt exit.
    """
    while time.monotonic() < deadline:
        readable, _, _ = select.select([0], [], [], 0.2)
        if not readable:
            continue
        try:
            data = os.read(0, 4096)
        except OSError:
            return
        if not data or _CTRL_C in data:
            return


def _run_tui_mode(config: dict, transcript: bytes) -> int:
    deadline = time.monotonic() + _MAX_SESSION_SECONDS

    # Raw mode so the scraper's ctrl-U (line-kill in cooked mode) and other
    # control bytes reach us verbatim, exactly as a real raw-mode Ink TUI reads
    # them. Absent a controlling tty (defensive), proceed without raw setup.
    try:
        import termios
        import tty

        tty.setraw(0)
        _ = termios  # imported for the side effect of tty.setraw needing it
    except Exception:  # noqa: BLE001 — no tty under some harnesses; degrade quietly
        pass

    os.write(1, _ALT_SCREEN_ENTER)

    mount_delay_ms = config.get("mount_delay_ms") or 0
    if mount_delay_ms:
        time.sleep(min(mount_delay_ms / 1000.0, _MAX_SESSION_SECONDS))

    if not config.get("paint_on_boot"):
        # The scraper types the slash command only after the panel is ready to
        # receive it; block until that sequence arrives before painting.
        if not _wait_for_slash_submit(deadline):
            return 0

    os.write(1, transcript)
    _drain_until_close(deadline)
    return 0


def main(argv: list[str]) -> int:
    config, transcript = _load_case()
    # The CLI's auth probe invokes `<command> auth status`; any argv carrying
    # `auth` selects the JSON probe response over the TUI replay.
    if "auth" in argv:
        return _run_auth_mode(config)
    return _run_tui_mode(config, transcript)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
