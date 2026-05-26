"""Drive a TUI through a PTY, scrape a screen, and return rendered text.

Public API:
    scrape(target_name: str, passthrough_args: list[str]) -> str

Targets:
    claude   spawn `claude`, navigate to /usage, scrape the panel
    codex    spawn `codex`,  navigate to /status, scrape the panel
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

import pexpect
import pyte

COLS, ROWS = 300, 100
QUIET_SECONDS = 0.6
SENTINEL_TIMEOUT = 90.0
SLASH_RETRIES = 2

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
        # Bare claude binary — we bypass the arthack-claude wrapper to avoid
        # its devctl-roots cwd prompt (which trips when spawning in /tmp) and
        # its plugin/auth setup overhead. Profile selection is handled here
        # by setting CLAUDE_CONFIG_DIR from --arthack-profile <name>.
        "command": "/Users/mike/.local/bin/claude",
        "slash": "/usage",
        # Bare binary boots faster than the wrapper, so pump_until_idle's
        # quiet window can fire while Ink is still mounting — keystrokes
        # then land before the input box is ready. Hold longer.
        "ready_wait": 4.0,
        # Wait for the exact required-label line the parser needs. Older
        # versions had a "Scanning local sessions…" loading phase, but
        # /usage in claude 2.1.150+ renders the data directly with no
        # scan indicator, so the loading sentinel never fires.
        "appear": "Current week (all models)",
        "gone": None,
    },
    "codex": {
        # Bare codex binary. We bypass arthack-codex but still need its
        # --dangerously-bypass-approvals-and-sandbox flag: without it, a
        # fresh sandbox cwd triggers a one-time approval prompt that our
        # pexpect flow doesn't dismiss, causing the child to exit early.
        #
        # Use the brew/npm install (the pnpm copy lags and triggers a
        # self-update loop: each launch detects npm-global is newer than
        # pnpm-global, runs `npm install -g`, and exits "please restart" —
        # never touching the pnpm binary we just launched).
        "command": "/opt/homebrew/bin/codex",
        "extra_args": ["--dangerously-bypass-approvals-and-sandbox"],
        "slash": "/status",
        # Codex's Ink TUI takes ~3-4s to mount and route keystrokes;
        # earlier sends get swallowed as placeholder-clearing keystrokes
        # in the input field rather than firing the slash command.
        "ready_wait": 5.0,
        # Wait for the LAST line of the panel ("Weekly limit:") rather than
        # the first ("5h limit:"). The panel paints top-down, so waiting on
        # the first line can return mid-render — leaving the Weekly line
        # half-drawn for the parser regex to miss.
        "appear": "Weekly limit:",
        "gone": None,
    },
}


def _extract_claude_profile(args: list[str]) -> tuple[list[str], str | None]:
    """Strip --arthack-profile <name> (or --arthack-profile=<name>) from args.

    Returns (remaining_args, profile_name_or_None). Used to translate the
    daemon's wrapper-shaped passthrough_args into a bare-claude env var.
    """
    out: list[str] = []
    profile: str | None = None
    i = 0
    while i < len(args):
        if args[i] == "--arthack-profile" and i + 1 < len(args):
            profile = args[i + 1]
            i += 2
        elif args[i].startswith("--arthack-profile="):
            profile = args[i].split("=", 1)[1]
            i += 1
        else:
            out.append(args[i])
            i += 1
    return out, profile


def _ensure_claude_dir_trusted(config_dir: Path, dir_path: str) -> None:
    """Mark `dir_path` as a trusted project in the profile's .claude.json.

    Without this, claude shows a hidden trust dialog on first entry to a
    sandbox dir that silently swallows slash-command keystrokes. The flags
    we set match what claude writes once the user manually accepts the
    dialog (isTrusted + hasTrustDialogAccepted on the parent-dir entry).
    Idempotent — safe to call before every spawn.
    """
    cj = config_dir / ".claude.json"
    if not cj.exists():
        return
    try:
        data = json.loads(cj.read_text())
    except (OSError, json.JSONDecodeError):
        return
    projects = data.setdefault("projects", {})
    entry = projects.setdefault(dir_path, {})
    if entry.get("isTrusted") and entry.get("hasTrustDialogAccepted"):
        return
    entry["isTrusted"] = True
    entry["hasTrustDialogAccepted"] = True
    cj.write_text(json.dumps(data, indent=2))


def _ensure_codex_dir_trusted(dir_path: str) -> None:
    """Append a `[projects."<dir_path>"]` trusted entry to ~/.codex/config.toml.

    Codex's slash commands (e.g. /status) silently no-op in untrusted
    project dirs. We append a TOML stanza if not already present —
    idempotent line-level write since TOML in stdlib is read-only.
    """
    cfg = Path.home() / ".codex" / "config.toml"
    if not cfg.exists():
        return
    text = cfg.read_text()
    needle = f'[projects."{dir_path}"]'
    if needle in text:
        return
    stanza = f'\n{needle}\ntrust_level = "trusted"\n'
    cfg.write_text(text + stanza)


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
        except pexpect.TIMEOUT:
            continue
        except pexpect.EOF:
            return _on_screen(screen, needle)
    return _on_screen(screen, needle)


def pump_while_text(child, screen, stream, needle, max_seconds=SENTINEL_TIMEOUT):
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        if not _on_screen(screen, needle):
            return True
        try:
            chunk = child.read_nonblocking(size=8192, timeout=0.2)
            stream.feed(chunk)
        except pexpect.TIMEOUT:
            continue
        except pexpect.EOF:
            return not _on_screen(screen, needle)
    return not _on_screen(screen, needle)


def send_slash_command(child, stream, slash: str) -> None:
    # Clear any partially typed input from an earlier swallowed send, then type
    # the slash command with a quiet pump before Enter so Ink can render matches.
    child.sendcontrol("u")
    pump_until_idle(child, stream)
    child.send(slash)
    pump_until_idle(child, stream)
    child.send("\r")


# ---------- Core scrape flow -----------------------------------------------


def scrape(target_name: str, passthrough_args: list[str]) -> str:
    target = TARGETS[target_name]

    extra_args = target.get("extra_args", [])
    assert isinstance(extra_args, list)
    args = list(extra_args) + list(passthrough_args)
    env = os.environ.copy()

    config_dir: Path | None = None
    if target_name == "claude":
        args, profile = _extract_claude_profile(args)
        if profile:
            config_dir = Path.home() / ".claude-profiles" / profile
            env["CLAUDE_CONFIG_DIR"] = str(config_dir)

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    # Spawn in a throwaway /tmp dir so the TUI doesn't auto-load whatever
    # project we happen to be running in (agentuse's own CLAUDE.md, planctl
    # state, etc.).
    with tempfile.TemporaryDirectory(prefix="agentuse-scrape-", dir="/tmp") as tmpdir:
        # Resolve symlinks (macOS /tmp -> /private/tmp) since both tools
        # canonicalize cwd before looking up trust state.
        tmpdir_real = str(Path(tmpdir).resolve())

        # Pre-mark the sandbox as trusted so the TUI doesn't show a hidden
        # trust dialog that silently eats slash-command keys. Claude indexes
        # trust on the /private/tmp parent; codex indexes on the exact cwd.
        if config_dir is not None:
            _ensure_claude_dir_trusted(config_dir, "/private/tmp")
        if target_name == "codex":
            _ensure_codex_dir_trusted(tmpdir_real)

        child = pexpect.spawn(
            target["command"],
            args=args,
            dimensions=(ROWS, COLS),
            encoding=None,
            timeout=10,
            cwd=tmpdir,
            env=env,
        )

        try:
            pump_until_idle(
                child, stream, quiet_seconds=target.get("ready_wait", QUIET_SECONDS)
            )

            if target["appear"]:
                appeared = False
                for attempt in range(SLASH_RETRIES):
                    send_slash_command(child, stream, target["slash"])
                    appeared = pump_until_text(
                        child, screen, stream, target["appear"]
                    )
                    if appeared:
                        break
                    if attempt + 1 < SLASH_RETRIES:
                        pump_until_idle(child, stream, quiet_seconds=2.0)
                if not appeared:
                    print(
                        f"warning: sentinel {target['appear']!r} never appeared",
                        file=sys.stderr,
                    )
            else:
                send_slash_command(child, stream, target["slash"])
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
            # Best-effort cleanup. If the child already died (EOF / I/O error),
            # don't let that mask a successful scrape's return value.
            try:
                child.sendcontrol("c")
                child.sendcontrol("c")
            except (OSError, pexpect.ExceptionPexpect):
                pass
            try:
                child.expect(pexpect.EOF, timeout=5)
            except (pexpect.TIMEOUT, OSError, pexpect.ExceptionPexpect):
                try:
                    child.terminate(force=True)
                except (OSError, pexpect.ExceptionPexpect):
                    pass
