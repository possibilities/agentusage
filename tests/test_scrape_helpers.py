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
