"""Table-driven coverage for ``scrape._extract_claude_profile``.

Pure arg-munging helper: strips ``--agentwrap-profile <name>`` (space form) or
``--agentwrap-profile=<name>`` (equals form) out of a wrapper-shaped passthrough
arg list, returning ``(remaining_args, profile_or_None)``.

Import ``scrape`` (the module) — the helper lives on the module.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install. Mirrors the sibling test files' pattern.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scrape  # noqa: E402


class _FakeChild:
    pid = None

    def sendcontrol(self, _key: str) -> None:
        return None

    def expect(self, *_args, **_kwargs) -> int:
        return 0

    def terminate(self, *, force: bool = False) -> None:
        return None


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
