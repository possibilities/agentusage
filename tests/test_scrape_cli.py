"""Contract coverage for the one-shot scrape CLI.

Asserts the discriminated JSON contract shape + exit code for each arm
(subscribed ok / no_subscription ok / signed_out ok / error), plus that stdout
carries exactly ONE JSON object and the util writes NO state. The real scrape is
monkeypatched out — NO live TUI spawns in the default run (the `live` marker
covers that).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# Repo lays flat at the parent dir; put it on the path so both the
# `agentusage` package and the flat `scrape`/`parse_*` modules import.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agentusage import scrape_cli  # noqa: E402
from parse_claude_usage import (  # noqa: E402
    PANEL_HEADER,
    ClaudeUsageEndpointRateLimited,
    ClaudeUsageParseError,
    NoActiveSubscription,
    SignedOut,
)
from parse_codex_status import (  # noqa: E402
    PANEL_SENTINEL,
    CodexStatusParseError,
)

SUBSCRIBED_USAGE = {
    "session": {"percent_used": 12.0, "resets_at": "2026-05-29T17:00:00-04:00"},
    "week": {"percent_used": 34.0, "resets_at": "2026-06-02T09:00:00-04:00"},
}


def _capture(capsys) -> tuple[dict, str]:
    """Parse the single stdout JSON object; return (payload, stderr)."""
    captured = capsys.readouterr()
    out = captured.out.strip()
    # Exactly one JSON object on stdout — no banner lines, no second object.
    assert out, "expected one JSON object on stdout, got nothing"
    assert "\n" not in out, f"expected exactly one stdout line, got: {out!r}"
    return json.loads(out), captured.err


def test_subscribed_claude_ok_arm(monkeypatch, capsys) -> None:
    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "rendered panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", lambda _: SUBSCRIBED_USAGE)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 0
    assert payload["schema_version"] == scrape_cli.SCHEMA_VERSION
    assert isinstance(payload["schema_version"], int)
    assert payload["status"] == "ok"
    assert payload["usage"] == SUBSCRIBED_USAGE
    assert payload["subscription_active"] is True
    assert "no_subscription" not in payload


def test_codex_ok_arm_has_null_subscription(monkeypatch, capsys) -> None:
    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "rendered panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "codex", lambda _: SUBSCRIBED_USAGE)

    rc = scrape_cli.run("codex", "codex", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 0
    assert payload["status"] == "ok"
    # Codex has no subscription concept — explicitly null, not absent.
    assert payload["subscription_active"] is None


def test_no_subscription_ok_arm(monkeypatch, capsys) -> None:
    def _raise_no_sub(_):
        raise NoActiveSubscription("no plan limits")

    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "breakdown panel")
    monkeypatch.setattr(scrape_cli, "_claude_auth_logged_in", lambda *_: True)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise_no_sub)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    # NoActiveSubscription is a SUCCESS arm: exit 0, no_subscription:true, and
    # NO usage / subscription_active keys.
    assert rc == 0
    assert payload["status"] == "ok"
    assert payload["no_subscription"] is True
    assert "usage" not in payload
    assert "subscription_active" not in payload


def test_no_subscription_logged_out_auth_status_emits_signed_out(
    monkeypatch, capsys
) -> None:
    def _raise_no_sub(_):
        raise NoActiveSubscription("no quota bars")

    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "api billing panel")
    monkeypatch.setattr(scrape_cli, "_claude_auth_logged_in", lambda *_: False)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise_no_sub)

    rc = scrape_cli.run("claude", "multi-claude-1", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 0
    assert payload["status"] == "ok"
    assert payload["signed_out"] is True
    assert "no_subscription" not in payload
    assert "usage" not in payload
    assert "subscription_active" not in payload


def test_no_subscription_inconclusive_auth_status_stays_no_subscription(
    monkeypatch, capsys
) -> None:
    def _raise_no_sub(_):
        raise NoActiveSubscription("no quota bars")

    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "api billing panel")
    monkeypatch.setattr(scrape_cli, "_claude_auth_logged_in", lambda *_: None)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise_no_sub)

    rc = scrape_cli.run("claude", "multi-claude-1", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 0
    assert payload["status"] == "ok"
    assert payload["no_subscription"] is True
    assert "signed_out" not in payload


def test_claude_auth_logged_in_uses_named_profile_dir(monkeypatch, tmp_path) -> None:
    calls = []

    def _fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout='{"loggedIn": false}\n')

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(scrape_cli.subprocess, "run", _fake_run)

    logged_in = scrape_cli._claude_auth_logged_in("multi-claude-1", "/bin/claude")

    assert logged_in is False
    args, kwargs = calls[0]
    assert args == ["/bin/claude", "auth", "status"]
    assert kwargs["env"]["CLAUDE_CONFIG_DIR"] == str(
        tmp_path / ".claude-profiles" / "multi-claude-1"
    )
    assert kwargs["capture_output"] is True
    assert kwargs["check"] is False


def test_claude_auth_logged_in_default_profile_unsets_config_dir(
    monkeypatch,
) -> None:
    calls = []

    def _fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout='{"loggedIn": true}\n')

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/wrong/profile")
    monkeypatch.setattr(scrape_cli.subprocess, "run", _fake_run)

    logged_in = scrape_cli._claude_auth_logged_in("default", "claude")

    assert logged_in is True
    _, kwargs = calls[0]
    assert "CLAUDE_CONFIG_DIR" not in kwargs["env"]


def test_default_claude_command_falls_back_for_non_string(monkeypatch) -> None:
    monkeypatch.setitem(scrape_cli.TARGETS["claude"], "command", ["not", "a", "string"])

    assert scrape_cli._default_claude_command() == "claude"


def test_claude_auth_logged_in_returns_none_on_probe_failure(monkeypatch) -> None:
    def _raise(*_args, **_kwargs):
        raise OSError("missing binary")

    monkeypatch.setattr(scrape_cli.subprocess, "run", _raise)

    assert scrape_cli._claude_auth_logged_in("default", "claude") is None


def test_claude_auth_logged_in_returns_none_on_bad_json(monkeypatch) -> None:
    monkeypatch.setattr(
        scrape_cli.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout="not json"),
    )

    assert scrape_cli._claude_auth_logged_in("default", "claude") is None


def test_claude_auth_logged_in_returns_none_on_non_bool_payload(monkeypatch) -> None:
    monkeypatch.setattr(
        scrape_cli.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout='{"loggedIn": "yes"}\n'),
    )

    assert scrape_cli._claude_auth_logged_in("default", "claude") is None


def test_main_forwards_args_to_run(monkeypatch) -> None:
    calls = []

    def _fake_run(**kwargs):
        calls.append(kwargs)
        return 7

    monkeypatch.setattr(scrape_cli, "run", _fake_run)

    rc = scrape_cli.main(
        [
            "--target",
            "codex",
            "--profile",
            "codex-profile",
            "--command",
            "/bin/codex",
            "--rows",
            "41",
            "--cols",
            "120",
        ]
    )

    assert rc == 7
    assert calls == [
        {
            "target": "codex",
            "profile": "codex-profile",
            "command": "/bin/codex",
            "rows": 41,
            "cols": 120,
        }
    ]


def test_signed_out_ok_arm(monkeypatch, capsys) -> None:
    def _raise_signed_out(*_, **__):
        raise SignedOut("OAuth sign-in screen detected pre-send")

    # scrape() raises SignedOut PRE-SEND for a logged-out profile; run() catches
    # it before the parser ever sees a screen.
    monkeypatch.setattr(scrape_cli, "scrape", _raise_signed_out)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    # SignedOut is a SUCCESS arm: exit 0, signed_out:true, and NO usage /
    # subscription_active / no_subscription keys. SCHEMA_VERSION stays 1.
    assert rc == 0
    assert payload["schema_version"] == 1
    assert payload["schema_version"] == scrape_cli.SCHEMA_VERSION
    assert payload["status"] == "ok"
    assert payload["signed_out"] is True
    assert "usage" not in payload
    assert "subscription_active" not in payload
    assert "no_subscription" not in payload


def test_signed_out_detector_throw_degrades_to_scrape_failed(
    monkeypatch, capsys
) -> None:
    # An UNEXPECTED detector throw (not SignedOut) must degrade to the existing
    # scrape_failed arm, never crash the util. scrape() lets the throw propagate
    # from inside its try; run()'s generic handler maps it to scrape_failed.
    def _detector_bug(*_, **__):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(scrape_cli, "scrape", _detector_bug)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_kind"] == "scrape_failed"
    assert payload["error_type"] == "RuntimeError"
    assert payload["screen_excerpt"] == []


def test_parse_drift_error_arm(monkeypatch, capsys) -> None:
    def _raise_parse_error(_):
        raise ClaudeUsageParseError("panel format changed")

    rendered = "line one\nline two\nline three"
    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: rendered)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise_parse_error)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, err = _capture(capsys)
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_type"] == "ClaudeUsageParseError"
    assert payload["message"] == "panel format changed"
    # No panel header in the rendered rows → the panel never rendered.
    assert payload["error_kind"] == "panel_missing"
    # screen_excerpt surfaces the rendered rows for human diagnosis.
    assert payload["screen_excerpt"] == ["line one", "line two", "line three"]
    # Tracebacks go to stderr, never stdout.
    assert "Traceback" in err


def test_scrape_crash_error_arm_empty_excerpt(monkeypatch, capsys) -> None:
    def _raise_scrape(*_, **__):
        raise RuntimeError("binary not found")

    monkeypatch.setattr(scrape_cli, "scrape", _raise_scrape)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    # A scrape crash before any screen renders is the error arm with an empty
    # excerpt (there is no rendered screen to excerpt).
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_type"] == "RuntimeError"
    assert payload["message"] == "binary not found"
    assert payload["error_kind"] == "scrape_failed"
    assert payload["screen_excerpt"] == []


# target, rendered screen, parser exception, expected error_kind.
# Panel evidence (claude header / codex `5h limit:`) is what separates real
# format drift from a panel that never rendered.
_CLAUDE_PANEL = f"{PANEL_HEADER}\nCurrent session\nsomething unexpected"
_CODEX_PANEL = "Codex usage\n5h limit:  [????] garbled (resets ??)"

_CLASSIFY_CASES = [
    pytest.param(
        "claude",
        _CLAUDE_PANEL,
        ClaudeUsageParseError("bars drifted"),
        "format_changed",
        id="claude-drift-with-panel",
    ),
    pytest.param(
        "claude",
        "totally unrelated screen\nno header here",
        ClaudeUsageParseError("panel never rendered"),
        "panel_missing",
        id="claude-missing-panel",
    ),
    pytest.param(
        "claude",
        "Usage endpoint is rate limited",
        ClaudeUsageEndpointRateLimited("endpoint throttled"),
        "upstream_limited",
        id="claude-endpoint-throttle",
    ),
    pytest.param(
        "codex",
        _CODEX_PANEL,
        CodexStatusParseError("weekly line drifted"),
        "format_changed",
        id="codex-drift-with-panel",
    ),
    pytest.param(
        "codex",
        "some other codex screen\nnothing parseable",
        CodexStatusParseError("panel never rendered"),
        "panel_missing",
        id="codex-missing-panel",
    ),
]


@pytest.mark.parametrize("target, rendered, exc, expected_kind", _CLASSIFY_CASES)
def test_error_kind_classification(
    monkeypatch, capsys, target, rendered, exc, expected_kind
) -> None:
    def _raise(_):
        raise exc

    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: rendered)
    monkeypatch.setitem(scrape_cli.PARSERS, target, _raise)

    profile = "default" if target == "claude" else "codex"
    rc = scrape_cli.run(target, profile, None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_kind"] == expected_kind
    # The detailed diagnostic truth survives alongside the classification.
    assert payload["error_type"] == type(exc).__name__
    assert payload["message"] == str(exc)


def test_endpoint_throttle_classifies_upstream_even_with_panel(
    monkeypatch, capsys
) -> None:
    # Endpoint throttling wins over panel evidence: the panel header is present
    # but the kind is upstream_limited, never format_changed.
    rendered = f"{PANEL_HEADER}\nUsage endpoint is rate limited"

    def _raise(_):
        raise ClaudeUsageEndpointRateLimited("endpoint throttled")

    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: rendered)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise)

    scrape_cli.run("claude", "default", None, None, None)

    payload, _ = _capture(capsys)
    assert payload["error_kind"] == "upstream_limited"


def test_codex_weekly_reset_drift_classifies_as_format_changed() -> None:
    # The current codex weekly reset shape drifts from the parser's WEEKLY_RE but
    # the `5h limit:` sentinel still renders — so it's format drift, not a missing
    # panel. Asserted against the real parser (fixing it is follow-up work).
    rendered = (
        "Codex usage\n"
        "5h limit:   [####] 99% left (resets 14:05)\n"
        "Weekly limit:  resets next Monday\n"  # new shape the parser rejects
    )
    assert PANEL_SENTINEL in rendered
    with pytest.raises(CodexStatusParseError):
        scrape_cli.PARSERS["codex"](rendered)
    assert scrape_cli._has_panel_evidence("codex", rendered) is True


def test_passthrough_translation() -> None:
    # Named Claude profiles route through the agentwrap-profile shim scrape()
    # reads. The default account is native ~/.claude, not ~/.claude-profiles/default.
    # Codex takes no passthrough.
    assert scrape_cli._passthrough_for("claude", "multi-1") == [
        "--agentwrap-profile",
        "multi-1",
    ]
    assert scrape_cli._passthrough_for("claude", "default") == []
    assert scrape_cli._passthrough_for("codex", "codex") == []


def test_writes_no_state(monkeypatch, capsys, tmp_path) -> None:
    # The util is stateless. Run it with HOME pointed at an empty tmp dir and
    # assert nothing was written there.
    monkeypatch.setattr(scrape_cli, "scrape", lambda *_, **__: "panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", lambda _: SUBSCRIBED_USAGE)
    monkeypatch.setenv("HOME", str(tmp_path))

    scrape_cli.run("claude", "default", None, None, None)
    capsys.readouterr()

    assert list(tmp_path.iterdir()) == []


def test_screen_excerpt_elides_long_panels() -> None:
    rendered = "\n".join(f"row {i}" for i in range(100))
    excerpt = scrape_cli._screen_excerpt(rendered, max_lines=24)
    assert len(excerpt) == 24
    assert any("lines omitted" in line for line in excerpt)
    assert excerpt[0] == "row 0"
    assert excerpt[-1] == "row 99"


def test_main_requires_target_and_profile() -> None:
    with pytest.raises(SystemExit):
        scrape_cli.main(["--target", "claude"])
    with pytest.raises(SystemExit):
        scrape_cli.main(["--profile", "default"])
