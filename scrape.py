"""Drive a TUI through a PTY, scrape a screen, and return rendered text.

Public API:
    scrape(target_name: str, passthrough_args: list[str]) -> str

Targets:
    claude   spawn `claude`, navigate to /usage, scrape the panel
    codex    spawn `codex`,  navigate to /status, scrape the panel
"""

import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

import pexpect
import pyte

COLS, ROWS = 300, 200
QUIET_SECONDS = 0.6
# Keep the full two-attempt sentinel budget inside keeper's 60s spawn timeout so
# a panel that never renders returns a structured parse error + screen excerpt
# instead of being SIGKILLed as runner_failure:timed_out.
SENTINEL_TIMEOUT = 15.0
SLASH_RETRIES = 2

# Best-effort wait for an optional follow-up row that paints after the
# primary appear sentinel (e.g. claude's conditional "Current week (Sonnet
# only)" bar, which is only present when Sonnet usage > 0%). Short enough
# that a Sonnet-absent account doesn't slow the scrape noticeably.
OPTIONAL_FOLLOW_TIMEOUT = 2.5

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
        # by setting CLAUDE_CONFIG_DIR from --agentwrap-profile <name>.
        "command": "/Users/mike/.local/bin/claude",
        "slash": "/usage",
        # Bare binary boots faster than the wrapper, so pump_until_idle's
        # quiet window can fire while Ink is still mounting — keystrokes
        # then land before the input box is ready. Hold longer.
        "ready_wait": 4.0,
        # Primary appear sentinel: the all-models weekly bar — present on
        # every claude account, deterministic, fast. We also do a
        # best-effort follow-up wait for the conditional Sonnet bar so
        # accounts with Sonnet usage > 0% capture it before we snapshot.
        "appear": "Current week (all models)",
        "appear_optional": "Current week (Sonnet only)",
        # Short-circuit sentinel for no-subscription accounts: the panel
        # opens to the usage-contribution breakdown ("% of usage") with NO
        # rate-limit bars. Keyed on the SAME string as parse_claude_usage
        # .NO_SUB_SENTINEL so the two detections cannot desync. When the
        # primary `appear` sentinel never matches AND this one does, we
        # snapshot immediately instead of burning the full retry budget.
        "appear_nosub": "% of usage",
        # Terminal error rendered by some accounts instead of usage bars. Treat
        # it as "panel settled" so the parser can return a structured error
        # promptly instead of waiting for the full appear-sentinel timeout.
        "appear_error": "Usage endpoint is rate limited",
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
    """Strip --agentwrap-profile <name> (or --agentwrap-profile=<name>) from args.

    Returns (remaining_args, profile_name_or_None). Used to translate the
    daemon's wrapper-shaped passthrough_args into a bare-claude env var.
    """
    out: list[str] = []
    profile: str | None = None
    i = 0
    while i < len(args):
        if args[i] == "--agentwrap-profile" and i + 1 < len(args):
            profile = args[i + 1]
            i += 2
        elif args[i].startswith("--agentwrap-profile="):
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


def pump_until_any_text(child, screen, stream, needles, max_seconds=SENTINEL_TIMEOUT):
    active = [needle for needle in needles if needle]
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        for needle in active:
            if _on_screen(screen, needle):
                return needle
        try:
            chunk = child.read_nonblocking(size=8192, timeout=0.2)
            stream.feed(chunk)
        except pexpect.TIMEOUT:
            continue
        except pexpect.EOF:
            for needle in active:
                if _on_screen(screen, needle):
                    return needle
            return None
    for needle in active:
        if _on_screen(screen, needle):
            return needle
    return None


def pump_until_text(child, screen, stream, needle, max_seconds=SENTINEL_TIMEOUT):
    return pump_until_any_text(child, screen, stream, [needle], max_seconds) == needle


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


def scrape(
    target_name: str,
    passthrough_args: list[str],
    *,
    command: str | None = None,
    rows: int | None = None,
    cols: int | None = None,
) -> str:
    target = TARGETS[target_name]

    extra_args = target.get("extra_args", [])
    assert isinstance(extra_args, list)
    slash = target["slash"]
    assert isinstance(slash, str)
    args = list(extra_args) + list(passthrough_args)

    spawn_rows = rows if rows is not None else ROWS
    spawn_cols = cols if cols is not None else COLS

    # Pin the terminal geometry + identity so pyte renders a deterministic
    # screen regardless of the (often absent) controlling-TTY environment under
    # keeperd. The Ink TUIs read LINES/COLUMNS/TERM; mismatched dims reflow the
    # panel and break the parser regexes.
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["LINES"] = str(spawn_rows)
    env["COLUMNS"] = str(spawn_cols)

    config_dir: Path | None = None
    if target_name == "claude":
        args, profile = _extract_claude_profile(args)
        if profile:
            config_dir = Path.home() / ".claude-profiles" / profile
            env["CLAUDE_CONFIG_DIR"] = str(config_dir)

    screen = pyte.Screen(spawn_cols, spawn_rows)
    stream = pyte.ByteStream(screen)

    # Spawn in a throwaway /tmp dir so the TUI doesn't auto-load whatever
    # project we happen to be running in (agentusage's own CLAUDE.md, planctl
    # state, etc.).
    with tempfile.TemporaryDirectory(prefix="agentusage-scrape-", dir="/tmp") as tmpdir:
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

        spawn_command = command if command is not None else target["command"]
        child = pexpect.spawn(
            spawn_command,
            args=args,
            dimensions=(spawn_rows, spawn_cols),
            encoding=None,
            timeout=10,
            cwd=tmpdir,
            env=env,  # type: ignore[arg-type]  # pexpect stubs require _Environ, dict[str,str] works
            # pexpect's forkpty already gives the spawned command its own
            # session/process group on macOS. Do not call os.setsid here: the
            # child is already a process-group leader, so setsid fails with
            # EPERM and the scrape never starts. The finally block still killpgs
            # child.pid's group to reap the TUI and any descendants.
        )

        try:
            pump_until_idle(
                child, stream, quiet_seconds=target.get("ready_wait", QUIET_SECONDS)
            )

            if target["appear"]:
                appeared = False
                nosub_short_circuit = False
                terminal_short_circuit = False
                appear_nosub = target.get("appear_nosub")
                appear_error = target.get("appear_error")
                for attempt in range(SLASH_RETRIES):
                    send_slash_command(child, stream, slash)
                    matched = pump_until_any_text(
                        child,
                        screen,
                        stream,
                        [target["appear"], appear_nosub, appear_error],
                    )
                    if matched == target["appear"]:
                        appeared = True
                        break
                    # On no-sub accounts the bars never paint so the retry
                    # budget would otherwise burn ~180s every cycle.
                    if appear_nosub and matched == appear_nosub:
                        nosub_short_circuit = True
                        break
                    # Some accounts render a terminal /usage error instead of
                    # bars. Snapshot immediately and let the parser emit the
                    # structured error + excerpt.
                    if appear_error and matched == appear_error:
                        terminal_short_circuit = True
                        break
                    if attempt + 1 < SLASH_RETRIES:
                        pump_until_idle(child, stream, quiet_seconds=2.0)
                if not appeared and not nosub_short_circuit and not terminal_short_circuit:
                    print(
                        f"warning: sentinel {target['appear']!r} never appeared",
                        file=sys.stderr,
                    )
                # Best-effort wait for a conditional follow-up row that
                # paints after `appear` (e.g. claude's "Current week
                # (Sonnet only)" bar, present only when Sonnet usage > 0%).
                # Timing out here is expected and silent — it just means
                # the row isn't on this account's panel.
                appear_optional = target.get("appear_optional")
                if appeared and appear_optional:
                    matched = pump_until_text(
                        child,
                        screen,
                        stream,
                        appear_optional,
                        max_seconds=OPTIONAL_FOLLOW_TIMEOUT,
                    )
                    if matched:
                        # The sentinel matched the row's label, but the
                        # bar and Resets lines below it render a moment
                        # later. Bounded settle so they land before we
                        # snapshot, without letting the breakdown phase
                        # scroll bars off pyte's buffer.
                        deadline = time.monotonic() + 1.0
                        while time.monotonic() < deadline:
                            try:
                                chunk = child.read_nonblocking(size=8192, timeout=0.2)
                                stream.feed(chunk)
                            except (pexpect.TIMEOUT, pexpect.EOF):
                                break
            else:
                send_slash_command(child, stream, slash)
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
            # Unconditional process-group reap. A bare terminate() above signals
            # only the python child; the grandchild `claude`/`codex` TUI shares
            # the forkpty-created process group, so SIGKILL the whole group to
            # guarantee no TUI survives a parent kill. Idempotent if the group
            # already exited (ProcessLookupError) — best-effort, never re-raises.
            if child.pid is not None:
                try:
                    os.killpg(os.getpgid(child.pid), signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
