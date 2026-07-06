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
import signal
import sys
import time
from pathlib import Path

# Absolute time budget for a single TUI invocation. A driver snapshots and reaps
# the fake in well under this; the cap only exists so a misdriven fake can never
# wedge a test run. It MUST outlive the driver's whole scrape, or the fake exits
# mid-drive and the driver captures a dead pane: the tmux driver burns its full
# two-attempt sentinel budget (~40s) on a panel that never paints an `appear`
# sentinel (api-billing, panel-missing), where pyte's persistent buffer lets the
# pexpect driver capture regardless. AGENTUSAGE_FAKE_MAX_SECONDS lets the dual-run
# harness raise the ceiling above that budget; the default stays tight.
_MAX_SESSION_SECONDS = float(os.environ.get("AGENTUSAGE_FAKE_MAX_SECONDS", "30"))

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
    # `auth_status_stdout`, when present, is emitted verbatim so a case can drive
    # the CLI's no-bar auth probe with a non-bool / malformed `loggedIn` (the
    # probe then reads inconclusive and the account stays no_subscription). Absent
    # → the normal boolean shape from the case's `logged_in`.
    raw = config.get("auth_status_stdout")
    if raw is not None:
        sys.stdout.write(raw)
    else:
        sys.stdout.write(json.dumps({"loggedIn": bool(config.get("logged_in"))}) + "\n")
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


def _fork_stubborn_child() -> None:
    """Fork a background child that shares the fake's process group and survives
    the driver's gentle signals — the reaping corpus's stand-in for a TUI that
    leaves a grandchild behind. Deliberately NOT setsid: it stays in the fake's
    session/process-group, the exact shape the pexpect killpg and the tmux
    kill-session cleanups are meant to sweep as a unit. Records its PID to
    AGENTUSAGE_FAKE_REAP_PIDFILE so the harness can assert no survivor after each
    CLI's cleanup, and self-exits after the session cap so a driver that FAILS to
    reap it still can't leak past the test run.
    """
    pidfile = os.environ.get("AGENTUSAGE_FAKE_REAP_PIDFILE")
    try:
        pid = os.fork()
    except OSError:
        return
    if pid != 0:
        return  # the fake (parent) keeps driving the TUI

    # ---- child ----
    # Keep the inherited controlling PTY: the cross-platform reap that actually
    # sweeps us is the kernel's SIGHUP to the foreground process group when the
    # session leader (the fake) dies. macOS getpgid() returns ESRCH for the fake
    # once it is a zombie, so pexpect's killpg backstop is a no-op here — the
    # controlling-terminal SIGHUP is what both drivers ultimately rely on. Ignore
    # only the gentle interactive stops so a mere ctrl-c / terminate() can't be
    # mistaken for a real reap; SIGHUP (session-leader death) and SIGKILL still
    # end us.
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, signal.SIG_IGN)
        except (OSError, ValueError):
            pass
    if pidfile:
        try:
            tmp = f"{pidfile}.{os.getpid()}.tmp"
            with open(tmp, "w") as handle:
                handle.write(str(os.getpid()))
            os.replace(tmp, pidfile)
        except OSError:
            pass
    deadline = time.monotonic() + _MAX_SESSION_SECONDS
    while time.monotonic() < deadline:
        time.sleep(0.2)
    os._exit(0)


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
    # Reaping corpus: leave a stubborn grandchild in the group so the harness can
    # confirm each CLI's cleanup sweeps it, not just the fake.
    if config.get("fork_child"):
        _fork_stubborn_child()
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
