"""Contract coverage for the one-shot scrape CLI.

Asserts the discriminated JSON contract shape + exit code for each arm
(subscribed ok / no_subscription ok / error), plus that stdout carries exactly
ONE JSON object and the util writes NO state. The real scrape is monkeypatched
out — NO live TUI spawns in the default run (the `live` marker covers that).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Repo lays flat at the parent dir; put it on the path so both the
# `agentusage` package and the flat `scrape`/`parse_*` modules import.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agentusage import scrape_cli  # noqa: E402
from parse_claude_usage import ClaudeUsageParseError, NoActiveSubscription  # noqa: E402

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
    monkeypatch.setattr(scrape_cli, "scrape", lambda *a, **k: "rendered panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", lambda text: SUBSCRIBED_USAGE)

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
    monkeypatch.setattr(scrape_cli, "scrape", lambda *a, **k: "rendered panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "codex", lambda text: SUBSCRIBED_USAGE)

    rc = scrape_cli.run("codex", "codex", None, None, None)

    payload, _ = _capture(capsys)
    assert rc == 0
    assert payload["status"] == "ok"
    # Codex has no subscription concept — explicitly null, not absent.
    assert payload["subscription_active"] is None


def test_no_subscription_ok_arm(monkeypatch, capsys) -> None:
    def _raise_no_sub(text):
        raise NoActiveSubscription("no plan limits")

    monkeypatch.setattr(scrape_cli, "scrape", lambda *a, **k: "breakdown panel")
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


def test_parse_drift_error_arm(monkeypatch, capsys) -> None:
    def _raise_parse_error(text):
        raise ClaudeUsageParseError("panel format changed")

    rendered = "line one\nline two\nline three"
    monkeypatch.setattr(scrape_cli, "scrape", lambda *a, **k: rendered)
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", _raise_parse_error)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, err = _capture(capsys)
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_type"] == "ClaudeUsageParseError"
    assert payload["message"] == "panel format changed"
    # screen_excerpt surfaces the rendered rows for human diagnosis.
    assert payload["screen_excerpt"] == ["line one", "line two", "line three"]
    # Tracebacks go to stderr, never stdout.
    assert "Traceback" in err


def test_scrape_crash_error_arm_empty_excerpt(monkeypatch, capsys) -> None:
    def _raise_scrape(*a, **k):
        raise RuntimeError("binary not found")

    monkeypatch.setattr(scrape_cli, "scrape", _raise_scrape)

    rc = scrape_cli.run("claude", "default", None, None, None)

    payload, err = _capture(capsys)
    # A scrape crash before any screen renders is the error arm with an empty
    # excerpt (there is no rendered screen to excerpt).
    assert rc == 1
    assert payload["status"] == "error"
    assert payload["error_type"] == "RuntimeError"
    assert payload["message"] == "binary not found"
    assert payload["screen_excerpt"] == []


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
    monkeypatch.setattr(scrape_cli, "scrape", lambda *a, **k: "panel")
    monkeypatch.setitem(scrape_cli.PARSERS, "claude", lambda text: SUBSCRIBED_USAGE)
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


def test_main_requires_target_and_profile(capsys) -> None:
    with pytest.raises(SystemExit):
        scrape_cli.main(["--target", "claude"])
    with pytest.raises(SystemExit):
        scrape_cli.main(["--profile", "default"])
