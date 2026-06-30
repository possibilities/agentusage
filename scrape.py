"""Drive a TUI through a PTY, scrape a screen, and return rendered text.

Public API:
    scrape(target_name: str, passthrough_args: list[str]) -> str

Targets:
    claude   spawn `claude`, navigate to /usage, scrape the panel
    codex    spawn `codex`,  navigate to /status, scrape the panel
"""

import json
import os
import shutil
import signal
import sys
import tempfile
import time
from collections.abc import Mapping
from pathlib import Path

import pexpect
import pyte

from parse_claude_usage import SignedOut

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
        # OAuth sign-in fingerprint for a logged-out profile. A 2-of-3 quorum
        # over the joined display (see _detect_signed_out) classifies the
        # account as signed_out PRE-SEND, before /usage is typed into the OAuth
        # "Paste code here" field. No single needle suffices: "Welcome to Claude
        # Code" can paint off the auth screen, so it only counts toward the
        # quorum alongside the paste prompt or the authorize URL.
        "signed_out_sentinels": (
            "Paste code here",
            "/oauth/authorize",
            "Welcome to Claude Code",
        ),
        "gone": None,
    },
    "codex": {
        # Bare codex binary. We bypass arthack-codex but still need its
        # --dangerously-bypass-approvals-and-sandbox flag: without it, a
        # fresh sandbox cwd triggers a one-time approval prompt that our
        # pexpect flow doesn't dismiss, causing the child to exit early.
        #
        # The binary path is resolved at launch by _resolve_codex_command():
        # prefer the newest nvm install (its sibling node is available), avoid
        # stale pnpm shims unless they are the only option, and fall back to
        # PATH. A hardcoded Homebrew path rots on machines that install Codex
        # through npm/pnpm/nvm instead.
        "command": "codex",
        "extra_args": ["--dangerously-bypass-approvals-and-sandbox"],
        "slash": "/status",
        # Codex's Ink TUI takes ~3-4s to mount and route keystrokes;
        # earlier sends get swallowed as placeholder-clearing keystrokes
        # in the input field rather than firing the slash command.
        "ready_wait": 5.0,
        # Wait for the LAST line of the panel ("Weekly limit:") rather than
        # the first ("5h limit:"). The panel paints top-down, and the label can
        # appear before the reset suffix finishes; settle briefly after the
        # sentinel so the parser sees the complete line.
        "appear": "Weekly limit:",
        "appear_settle": 1.0,
        # Optional second Codex-Spark quota bucket; if present, wait for its
        # header and one extra settle so both spark rows finish rendering.
        "appear_optional": "Codex-Spark limit:",
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


def _node_version_key(path: Path) -> tuple[int, ...]:
    """Sort key for ~/.nvm/versions/node/vX.Y.Z/bin/codex candidates."""
    version = path.parent.parent.name
    if version.startswith("v"):
        version = version[1:]
    parts: list[int] = []
    for part in version.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            parts.append(-1)
    return tuple(parts)


def _executable(path: str) -> bool:
    return Path(path).is_file() and os.access(path, os.X_OK)


def _resolve_codex_command(
    *,
    home: Path | None = None,
    env: Mapping[str, str] | None = None,
    which_codex: str | None = None,
) -> str:
    """Resolve a stable Codex CLI path for non-interactive scraper launches.

    LaunchAgents usually have a stripped PATH, while user shells may point at a
    stale pnpm shim that opens Codex's self-update prompt instead of the TUI. The
    scraper wants the newest real install it can find. `AGENTUSAGE_CODEX_COMMAND`
    remains an explicit escape hatch; the CLI's `--command` override is handled
    before this helper is called.
    """
    home = home or Path.home()
    if env is None:
        env = os.environ

    explicit = (env.get("AGENTUSAGE_CODEX_COMMAND") or "").strip()
    if explicit:
        return explicit

    candidates: list[str] = []

    nvm_root = home / ".nvm" / "versions" / "node"
    if nvm_root.exists():
        nvm_codex = sorted(
            nvm_root.glob("*/bin/codex"), key=_node_version_key, reverse=True
        )
        candidates.extend(str(path) for path in nvm_codex)

    found = which_codex
    if found is None:
        found = shutil.which("codex", path=env.get("PATH"))
    if found and "/Library/pnpm/" not in found:
        candidates.append(found)

    candidates.extend(
        [
            "/Applications/Codex.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
        ]
    )

    if found:
        candidates.append(found)
    candidates.append(str(home / "Library" / "pnpm" / "bin" / "codex"))

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if _executable(candidate):
            return candidate
    return "codex"


# ---------- PTY / pyte helpers ---------------------------------------------


def _on_screen(screen, needle):
    return any(needle in line for line in screen.display)


# pyte stores private DEC modes left-shifted by 5 (its Stream marks `?`-prefixed
# modes this way): DECAWM 7 -> 224, DECTCEM 25 -> 800. The alternate-screen
# buffer is private mode 1049 (1047 on older apps); a full-screen Ink TUI like
# claude/codex switches into it on boot, so its presence in screen.mode proves
# the TUI took the whole screen rather than a sentinel sitting in scrollback.
_PRIVATE_MODE_SHIFT = 5
_ALT_SCREEN_MODES = frozenset(code << _PRIVATE_MODE_SHIFT for code in (1047, 1049))


def _alt_screen_active(screen) -> bool:
    return bool(_ALT_SCREEN_MODES.intersection(screen.mode))


def _joined_display(display_lines) -> tuple[str, str]:
    """Return (newline_joined, dewrapped) search corpora for sentinel matching.

    `newline_joined` keeps row structure for a sentinel that sits on one row;
    `dewrapped` concatenates the rows with no separator so a sentinel a terminal
    wrap split across two rows still matches (pyte fills a wrapped row to full
    width, so rstrip never eats the seam).
    """
    stripped = [line.rstrip() for line in display_lines]
    return "\n".join(stripped), "".join(stripped)


def _detect_signed_out(screen, sentinels, *, min_hits: int = 2) -> bool:
    """True when the post-pyte alt-screen shows the OAuth sign-in fingerprint.

    Requires a `min_hits`-of-N sentinel quorum over the joined `screen.display`
    so one stray needle can't false-positive and a wrap-split needle still
    counts. Gated on the alt-screen being active so a sentinel sitting in the
    normal-buffer scrollback (or an adversarial ANSI cursor-jump that never took
    the screen) can't spoof a sign-in. Reads only the rendered display, never
    raw child bytes.
    """
    if not _alt_screen_active(screen):
        return False
    newline_joined, dewrapped = _joined_display(screen.display)
    hits = sum(1 for s in sentinels if s in newline_joined or s in dewrapped)
    return hits >= min_hits


def pump_until_idle(child, stream, quiet_seconds=QUIET_SECONDS):
    while True:
        try:
            chunk = child.read_nonblocking(size=8192, timeout=quiet_seconds)
            stream.feed(chunk)
        except (pexpect.TIMEOUT, pexpect.EOF, OSError):
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
        except (pexpect.EOF, OSError):
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
        except (pexpect.EOF, OSError):
            return not _on_screen(screen, needle)
    return not _on_screen(screen, needle)


def pump_for(child, stream, max_seconds: float) -> None:
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        try:
            chunk = child.read_nonblocking(size=8192, timeout=0.2)
            stream.feed(chunk)
        except pexpect.TIMEOUT:
            continue
        except (pexpect.EOF, OSError):
            return


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

    spawn_command = command if command is not None else target["command"]
    assert isinstance(spawn_command, str)
    if target_name == "codex" and command is None:
        spawn_command = _resolve_codex_command(env=env)

    # Node-backed shims commonly use `#!/usr/bin/env node`; prepend the chosen
    # binary's directory so a stripped LaunchAgent PATH can still find sibling
    # `node` when spawning an absolute nvm-managed `codex`.
    if os.path.isabs(spawn_command):
        command_dir = str(Path(spawn_command).parent)
        env["PATH"] = f"{command_dir}{os.pathsep}{env.get('PATH', '')}"

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

            # Pre-send sign-in gate: a logged-out profile renders the OAuth
            # screen, not a usage panel. Classify it BEFORE send_slash_command,
            # which does ctrl+u then types `/usage`+Enter into whatever field
            # has focus — on the sign-in screen that field is the OAuth "Paste
            # code here" input, so a post-send check would already have poisoned
            # it with a bogus auth code. Living inside this try means a detector
            # throw propagates to the caller's scrape_failed arm, never crashes.
            signed_out_sentinels = target.get("signed_out_sentinels")
            if signed_out_sentinels and _detect_signed_out(
                screen, signed_out_sentinels
            ):
                raise SignedOut(
                    "claude OAuth sign-in screen detected pre-send — "
                    "profile is logged out"
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
                if (
                    not appeared
                    and not nosub_short_circuit
                    and not terminal_short_circuit
                ):
                    print(
                        f"warning: sentinel {target['appear']!r} never appeared",
                        file=sys.stderr,
                    )
                appear_settle = target.get("appear_settle")
                if (
                    appeared
                    and isinstance(appear_settle, (int, float))
                    and appear_settle > 0
                ):
                    pump_for(child, stream, max_seconds=float(appear_settle))

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
                        pump_for(child, stream, max_seconds=1.0)
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
