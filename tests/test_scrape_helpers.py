"""Table-driven coverage for ``scrape._extract_claude_profile``.

Pure arg-munging helper: strips ``--agentwrap-profile <name>`` (space form) or
``--agentwrap-profile=<name>`` (equals form) out of a wrapper-shaped passthrough
arg list, returning ``(remaining_args, profile_or_None)``.

Import ``scrape`` (the module) — the helper lives on the module.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import cast

import pytest
import pyte

# Repo lays flat (no `src/`); make the modules importable without an editable
# install. Mirrors the sibling test files' pattern.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scrape  # noqa: E402

# Sentinels the claude target fingerprints the OAuth sign-in screen with.
SIGNIN_SENTINELS = scrape.TARGETS["claude"]["signed_out_sentinels"]


def _alt_render(lines: list[str], *, cols: int = 80, rows: int = 24, alt: bool = True):
    """Feed `lines` through a real pyte Screen and return it.

    Mirrors the production path: bytes -> ByteStream -> Screen, with the same
    alternate-screen enter sequence (CSI ? 1049 h) the Ink TUIs emit on boot so
    `_alt_screen_active` sees the buffer the detector gates on.
    """
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    if alt:
        stream.feed(b"\x1b[?1049h")
    stream.feed("\r\n".join(lines).encode())
    return screen


def test_detect_signed_out_quorum_classifies_signin() -> None:
    # Two of three sentinels present (paste prompt + authorize URL, no banner).
    screen = _alt_render(
        [
            "Sign in to continue",
            "Browser didn't open? Visit:",
            "https://claude.ai/oauth/authorize?client_id=abc&scope=read",
            "",
            "Paste code here > ",
        ]
    )
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is True


def test_detect_signed_out_matches_wrap_split_url() -> None:
    # Narrow terminal wraps the authorize URL mid-token: "/oauth/authorize" is
    # split across two rows and sits on NO single display line, yet the dewrapped
    # corpus reconstructs it. Paired with the paste prompt that's a 2-of-3 quorum.
    screen = _alt_render(
        [
            "Visit https://claude.ai/oauth/authorize?code=1",
            "Paste code here > ",
        ],
        cols=30,
    )
    assert not any("/oauth/authorize" in line for line in screen.display)
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is True


def test_detect_signed_out_requires_alt_screen() -> None:
    # Same sign-in content but the TUI never took the alt-screen buffer — a
    # sentinel in the normal buffer / scrollback must not spoof a sign-in.
    screen = _alt_render(
        [
            "https://claude.ai/oauth/authorize?client_id=abc",
            "Paste code here > ",
        ],
        alt=False,
    )
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is False


def test_detect_signed_out_single_needle_not_enough() -> None:
    # The banner alone (1 of 3) can paint off the auth screen; it must not trip.
    screen = _alt_render(["Welcome to Claude Code", "Tips for getting started:"])
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is False


def test_detect_signed_out_ignores_trust_dialog() -> None:
    # A logged-out profile can also hit the trust dialog; it carries none of the
    # OAuth sentinels, so it must not classify as signed_out.
    screen = _alt_render(
        [
            "Do you trust the files in this folder?",
            "/private/tmp/agentusage-scrape-xyz",
            "",
            "1. Yes, proceed",
            "2. No, exit",
        ]
    )
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is False


def test_detect_signed_out_ignores_slow_panel() -> None:
    # A merely-slow /usage panel still rendering its header is not a sign-in.
    screen = _alt_render(
        [
            "Settings  Status   Config   Usage   Stats",
            "",
            "Loading usage...",
        ]
    )
    assert scrape._detect_signed_out(screen, SIGNIN_SENTINELS) is False


def test_scrape_raises_signed_out_pre_send(monkeypatch: pytest.MonkeyPatch) -> None:
    # When the detector fires, scrape() raises SignedOut BEFORE send_slash_command
    # — proving /usage is never typed into the OAuth paste field.
    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_a, **_k: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_a, **_k: None)
    monkeypatch.setattr(scrape, "_detect_signed_out", lambda *_a, **_k: True)

    def _fail_if_sent(*_a, **_k):
        raise AssertionError("send_slash_command ran after sign-in detection")

    monkeypatch.setattr(scrape, "send_slash_command", _fail_if_sent)

    with pytest.raises(scrape.SignedOut):
        scrape.scrape("claude", [], command="/bin/true")


def test_scrape_detector_exception_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    # An unexpected detector throw propagates out of scrape() (cleanup still runs
    # in finally) so the caller maps it to the scrape_failed arm — never crashes.
    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_a, **_k: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_a, **_k: None)

    def _boom(*_a, **_k):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(scrape, "_detect_signed_out", _boom)

    with pytest.raises(RuntimeError, match="detector blew up"):
        scrape.scrape("claude", [], command="/bin/true")


class _FakeChild:
    pid = None

    def read_nonblocking(self, *_args, **_kwargs) -> bytes:
        raise scrape.pexpect.EOF("done")

    def sendcontrol(self, _key: str) -> None:
        return None

    def expect(self, *_args, **_kwargs) -> int:
        return 0

    def terminate(self, *, force: bool = False) -> None:
        return None


class _ScriptedChild:
    def __init__(self, *events: bytes | Exception) -> None:
        self.events = list(events)

    def read_nonblocking(self, *_args, **_kwargs) -> bytes:
        if not self.events:
            raise scrape.pexpect.TIMEOUT("quiet")
        event = self.events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event


class _RecordingStream:
    def __init__(self, screen) -> None:
        self.screen = screen
        self.chunks: list[bytes] = []

    def feed(self, chunk: bytes) -> None:
        self.chunks.append(chunk)
        self.screen.display = [chunk.decode()]


def test_pump_until_any_text_returns_first_present_sentinel() -> None:
    class Screen:
        display = ["", "Error: Usage endpoint is rate limited. Please try again."]

    matched = scrape.pump_until_any_text(
        None,
        Screen(),
        None,
        ["Current week (all models)", "Usage endpoint is rate limited"],
        max_seconds=0,
    )

    assert matched == "Usage endpoint is rate limited"


def test_pump_helpers_treat_pty_eio_as_closed_output() -> None:
    class EioChild:
        def read_nonblocking(self, *_args, **_kwargs) -> bytes:
            raise OSError(5, "Input/output error")

    class Screen:
        display = ["ready sentinel"]

    class Stream:
        def feed(self, _chunk: bytes) -> None:
            raise AssertionError("no bytes should feed after PTY EIO")

    child = EioChild()
    stream = Stream()

    scrape.pump_until_idle(child, stream, quiet_seconds=0)
    assert (
        scrape.pump_until_any_text(child, Screen(), stream, ["missing"], max_seconds=1)
        is None
    )
    assert scrape.pump_while_text(child, Screen(), stream, "ready sentinel") is False
    scrape.pump_for(child, stream, max_seconds=1)


def test_pump_helpers_feed_chunks_before_stopping() -> None:
    class Screen:
        display = [""]

    screen = Screen()
    stream = _RecordingStream(screen)

    idle_child = _ScriptedChild(b"boot", scrape.pexpect.TIMEOUT("quiet"))
    scrape.pump_until_idle(idle_child, stream, quiet_seconds=0)
    assert stream.chunks == [b"boot"]

    text_child = _ScriptedChild(b"ready sentinel")
    assert (
        scrape.pump_until_any_text(
            text_child, screen, stream, ["ready sentinel"], max_seconds=1
        )
        == "ready sentinel"
    )

    screen.display = ["loading"]
    gone_child = _ScriptedChild(b"done")
    assert scrape.pump_while_text(gone_child, screen, stream, "loading") is True

    for_child = _ScriptedChild(b"settle", scrape.pexpect.EOF("done"))
    scrape.pump_for(for_child, stream, max_seconds=1)
    assert b"settle" in stream.chunks


def test_send_slash_command_clears_types_and_submits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Child:
        def __init__(self) -> None:
            self.actions: list[tuple[str, str]] = []

        def sendcontrol(self, key: str) -> None:
            self.actions.append(("control", key))

        def send(self, text: str) -> None:
            self.actions.append(("send", text))

    pumps: list[str] = []
    monkeypatch.setattr(
        scrape, "pump_until_idle", lambda *_args, **_kwargs: pumps.append("idle")
    )

    child = Child()
    scrape.send_slash_command(child, object(), "/usage")

    assert child.actions == [("control", "u"), ("send", "/usage"), ("send", "\r")]
    assert pumps == ["idle", "idle"]


def _touch_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | 0o111)
    return path


def test_ensure_claude_dir_trusted_marks_project_and_is_idempotent(
    tmp_path: Path,
) -> None:
    config_dir = tmp_path / "profile"
    config_dir.mkdir()
    claude_json = config_dir / ".claude.json"
    claude_json.write_text(json.dumps({"projects": {}}))

    scrape._ensure_claude_dir_trusted(config_dir, "/private/tmp")

    data = json.loads(claude_json.read_text())
    entry = data["projects"]["/private/tmp"]
    assert entry["isTrusted"] is True
    assert entry["hasTrustDialogAccepted"] is True

    before = claude_json.read_text()
    scrape._ensure_claude_dir_trusted(config_dir, "/private/tmp")
    assert claude_json.read_text() == before


def test_ensure_claude_dir_trusted_ignores_missing_or_invalid_config(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "missing-profile"
    scrape._ensure_claude_dir_trusted(missing, "/private/tmp")
    assert not (missing / ".claude.json").exists()

    config_dir = tmp_path / "profile"
    config_dir.mkdir()
    claude_json = config_dir / ".claude.json"
    claude_json.write_text("not json")

    scrape._ensure_claude_dir_trusted(config_dir, "/private/tmp")
    assert claude_json.read_text() == "not json"


def test_ensure_codex_dir_trusted_appends_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(scrape.Path, "home", lambda: tmp_path)

    scrape._ensure_codex_dir_trusted("/private/tmp/agentusage")

    cfg = tmp_path / ".codex" / "config.toml"
    assert not cfg.exists()

    cfg.parent.mkdir()
    cfg.write_text('model = "gpt"\n')
    scrape._ensure_codex_dir_trusted("/private/tmp/agentusage")
    scrape._ensure_codex_dir_trusted("/private/tmp/agentusage")

    text = cfg.read_text()
    assert text.count('[projects."/private/tmp/agentusage"]') == 1
    assert 'trust_level = "trusted"' in text


def test_resolve_codex_command_prefers_latest_nvm_over_pnpm(tmp_path: Path) -> None:
    old_nvm = _touch_executable(tmp_path / ".nvm/versions/node/v20.1.0/bin/codex")
    new_nvm = _touch_executable(tmp_path / ".nvm/versions/node/v24.16.0/bin/codex")
    pnpm = _touch_executable(tmp_path / "Library/pnpm/bin/codex")

    resolved = scrape._resolve_codex_command(
        home=tmp_path,
        env={"PATH": str(pnpm.parent)},
        which_codex=str(pnpm),
    )

    assert resolved == str(new_nvm)
    assert resolved != str(old_nvm)


def test_resolve_codex_command_honors_explicit_env(tmp_path: Path) -> None:
    explicit = tmp_path / "custom-codex"

    resolved = scrape._resolve_codex_command(
        home=tmp_path,
        env={"AGENTUSAGE_CODEX_COMMAND": str(explicit)},
        which_codex=None,
    )

    assert resolved == str(explicit)


def test_resolve_codex_command_uses_path_candidate(tmp_path: Path) -> None:
    path_codex = _touch_executable(tmp_path / "bin/codex")

    resolved = scrape._resolve_codex_command(
        home=tmp_path,
        env={"PATH": ""},
        which_codex=str(path_codex),
    )

    assert resolved == str(path_codex)


def test_resolve_codex_command_handles_non_numeric_nvm_version(
    tmp_path: Path,
) -> None:
    beta_codex = _touch_executable(tmp_path / ".nvm/versions/node/v24.beta.0/bin/codex")

    resolved = scrape._resolve_codex_command(
        home=tmp_path,
        env={"PATH": ""},
        which_codex=None,
    )

    assert resolved == str(beta_codex)


def test_resolve_codex_command_falls_back_to_binary_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(scrape, "_executable", lambda _path: False)

    resolved = scrape._resolve_codex_command(
        home=tmp_path,
        env={"PATH": ""},
        which_codex=None,
    )

    assert resolved == "codex"


def test_resolve_codex_command_defaults_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("PATH", "")

    resolved = scrape._resolve_codex_command(home=tmp_path, which_codex=None)

    assert isinstance(resolved, str)


def test_scrape_does_not_pass_setsid_preexec(monkeypatch: pytest.MonkeyPatch) -> None:
    """forkpty already creates a process group; os.setsid preexec fails on macOS."""
    seen_kwargs: dict[str, object] = {}

    def fake_spawn(*_args, **kwargs):
        seen_kwargs.update(kwargs)
        return _FakeChild()

    monkeypatch.setattr(scrape.pexpect, "spawn", fake_spawn)
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["claude"]["appear"],
    )

    def fake_pump_until_text(*args, **_kwargs):
        needle = args[3]
        return needle != scrape.TARGETS["claude"].get("appear_optional")

    monkeypatch.setattr(scrape, "pump_until_text", fake_pump_until_text)

    scrape.scrape("claude", [], command="/bin/true")

    assert "preexec_fn" not in seen_kwargs


def test_scrape_prepends_spawn_command_dir_to_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen_kwargs: dict[str, object] = {}
    command = _touch_executable(tmp_path / "bin/codex")

    def fake_spawn(*_args, **kwargs):
        seen_kwargs.update(kwargs)
        return _FakeChild()

    monkeypatch.setattr(scrape.pexpect, "spawn", fake_spawn)
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["codex"]["appear"],
    )

    scrape.scrape("codex", [], command=str(command))

    env = seen_kwargs["env"]
    assert isinstance(env, dict)
    env = cast("dict[str, str]", env)
    assert env["PATH"].split(os.pathsep)[0] == str(command.parent)


def test_scrape_sets_named_claude_profile_env_and_trusts_tmp(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen_kwargs: dict[str, object] = {}
    trusted: list[tuple[Path, str]] = []

    def fake_spawn(*_args, **kwargs):
        seen_kwargs.update(kwargs)
        return _FakeChild()

    monkeypatch.setattr(scrape.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(scrape.pexpect, "spawn", fake_spawn)
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["claude"]["appear"],
    )
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        scrape,
        "_ensure_claude_dir_trusted",
        lambda config_dir, dir_path: trusted.append((config_dir, dir_path)),
    )

    scrape.scrape(
        "claude",
        ["--agentwrap-profile", "multi-claude-1", "--model", "opus"],
        command="/bin/true",
    )

    assert trusted == [
        (tmp_path / ".claude-profiles" / "multi-claude-1", "/private/tmp")
    ]
    assert seen_kwargs["args"] == ["--model", "opus"]
    env = seen_kwargs["env"]
    assert isinstance(env, dict)
    env = cast("dict[str, str]", env)
    assert env["CLAUDE_CONFIG_DIR"] == str(
        tmp_path / ".claude-profiles" / "multi-claude-1"
    )


def test_scrape_resolves_codex_command_and_marks_tmp_trusted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}
    trusted_dirs: list[str] = []

    def fake_spawn(command, *_args, **kwargs):
        seen["command"] = command
        seen["kwargs"] = kwargs
        return _FakeChild()

    def fake_resolve(*, env):
        seen["resolve_env"] = env
        return "/tmp/fake-codex"

    monkeypatch.setattr(scrape.pexpect, "spawn", fake_spawn)
    monkeypatch.setattr(scrape, "_resolve_codex_command", fake_resolve)
    monkeypatch.setattr(
        scrape,
        "_ensure_codex_dir_trusted",
        lambda dir_path: trusted_dirs.append(dir_path),
    )
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["codex"]["appear"],
    )
    monkeypatch.setattr(scrape, "pump_for", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: False)

    scrape.scrape("codex", [])

    assert seen["command"] == "/tmp/fake-codex"
    assert trusted_dirs and trusted_dirs[0].startswith(
        "/private/tmp/agentusage-scrape-"
    )


def test_scrape_short_circuits_on_no_subscription_or_endpoint_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    sent: list[str] = []

    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_args, **_kwargs: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape, "send_slash_command", lambda *_args, **_kwargs: sent.append("send")
    )
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: False)

    for sentinel_key in ("appear_nosub", "appear_error"):
        sent.clear()
        monkeypatch.setattr(
            scrape,
            "pump_until_any_text",
            lambda *_args, sentinel_key=sentinel_key, **_kwargs: scrape.TARGETS[
                "claude"
            ][sentinel_key],
        )

        scrape.scrape("claude", [], command="/bin/true")

        assert sent == ["send"]
        assert capsys.readouterr().err == ""


def test_scrape_retries_and_warns_when_appear_sentinel_never_matches(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    sent: list[str] = []
    idle_quiets: list[float | None] = []

    def fake_idle(*_args, **kwargs):
        idle_quiets.append(kwargs.get("quiet_seconds"))

    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_args, **_kwargs: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", fake_idle)
    monkeypatch.setattr(
        scrape, "send_slash_command", lambda *_args, **_kwargs: sent.append("send")
    )
    monkeypatch.setattr(scrape, "pump_until_any_text", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: False)

    scrape.scrape("claude", [], command="/bin/true")

    err = capsys.readouterr().err
    assert sent == ["send", "send"]
    assert 2.0 in idle_quiets
    assert "warning: sentinel 'Current week (all models)' never appeared" in err


def test_scrape_waits_for_optional_followup_and_settles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settles: list[float] = []

    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_args, **_kwargs: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["claude"]["appear"],
    )
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(
        scrape,
        "pump_for",
        lambda *_args, **kwargs: settles.append(float(kwargs["max_seconds"])),
    )

    scrape.scrape("claude", [], command="/bin/true")

    assert settles == [1.0]


def test_scrape_handles_gone_sentinel_warning(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setitem(
        scrape.TARGETS,
        "dummy-gone",
        {
            "command": "/bin/true",
            "slash": "/dismiss",
            "appear": None,
            "gone": "Loading",
        },
    )
    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_args, **_kwargs: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "pump_while_text", lambda *_args, **_kwargs: False)

    scrape.scrape("dummy-gone", [])

    assert "warning: sentinel 'Loading' never cleared" in capsys.readouterr().err


def test_scrape_uses_idle_fallback_when_no_sentinels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quiets: list[float | None] = []

    def fake_idle(*_args, **kwargs):
        quiets.append(kwargs.get("quiet_seconds"))

    monkeypatch.setitem(
        scrape.TARGETS,
        "dummy-idle",
        {"command": "/bin/true", "slash": "/status", "appear": None, "gone": None},
    )
    monkeypatch.setattr(scrape.pexpect, "spawn", lambda *_args, **_kwargs: _FakeChild())
    monkeypatch.setattr(scrape, "pump_until_idle", fake_idle)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)

    scrape.scrape("dummy-idle", [])

    assert quiets[-1] == 4.0


def test_scrape_cleanup_swallows_child_and_process_group_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CleanupChild(_FakeChild):
        pid = 123

        def sendcontrol(self, _key: str) -> None:
            raise OSError("closed")

        def expect(self, *_args, **_kwargs) -> int:
            raise scrape.pexpect.TIMEOUT("still running")

        def terminate(self, *, force: bool = False) -> None:
            raise OSError("already gone")

    monkeypatch.setattr(
        scrape.pexpect, "spawn", lambda *_args, **_kwargs: CleanupChild()
    )
    monkeypatch.setattr(scrape, "pump_until_idle", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scrape, "send_slash_command", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scrape,
        "pump_until_any_text",
        lambda *_args, **_kwargs: scrape.TARGETS["claude"]["appear"],
    )
    monkeypatch.setattr(scrape, "pump_until_text", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(scrape.os, "getpgid", lambda pid: pid + 10)

    def fake_killpg(_pgid, _sig):
        raise ProcessLookupError

    monkeypatch.setattr(scrape.os, "killpg", fake_killpg)

    scrape.scrape("claude", [], command="/bin/true")


@pytest.mark.parametrize(
    ("args", "expected_remaining", "expected_profile"),
    [
        # Space form: `--agentwrap-profile foo`.
        (["--agentwrap-profile", "foo"], [], "foo"),
        # Equals form: `--agentwrap-profile=foo`.
        (["--agentwrap-profile=foo"], [], "foo"),
        # Flag absent: everything passes through, profile is None.
        (["--model", "opus", "--print"], ["--model", "opus", "--print"], None),
        # Empty input.
        ([], [], None),
        # Interleaved with passthrough args (space form).
        (
            ["--model", "opus", "--agentwrap-profile", "foo", "--print"],
            ["--model", "opus", "--print"],
            "foo",
        ),
        # Interleaved with passthrough args (equals form).
        (
            ["--model", "opus", "--agentwrap-profile=foo", "--print"],
            ["--model", "opus", "--print"],
            "foo",
        ),
        # Multiple occurrences: last wins (space form).
        (
            ["--agentwrap-profile", "foo", "--agentwrap-profile", "bar"],
            [],
            "bar",
        ),
        # Multiple occurrences: last wins (mixed forms).
        (
            ["--agentwrap-profile=foo", "--agentwrap-profile", "bar"],
            [],
            "bar",
        ),
        # Trailing `--agentwrap-profile` with no value: there's no `i+1` and it
        # doesn't match the `=` prefix, so it falls through to passthrough and
        # profile stays None.
        (["--agentwrap-profile"], ["--agentwrap-profile"], None),
        # No-value trailing flag after real passthrough args.
        (
            ["--model", "opus", "--agentwrap-profile"],
            ["--model", "opus", "--agentwrap-profile"],
            None,
        ),
    ],
)
def test_extract_claude_profile(
    args: list[str],
    expected_remaining: list[str],
    expected_profile: str | None,
) -> None:
    remaining, profile = scrape._extract_claude_profile(args)
    assert remaining == expected_remaining
    assert profile == expected_profile
