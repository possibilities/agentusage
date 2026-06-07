"""Table-driven coverage for ``scrape._extract_claude_profile``.

Pure arg-munging helper: strips ``--arthack-profile <name>`` (space form) or
``--arthack-profile=<name>`` (equals form) out of a wrapper-shaped passthrough
arg list, returning ``(remaining_args, profile_or_None)``.

Import ``scrape`` (the module), NOT ``scrape_one`` — the helper lives on the
module and ``scrape_one`` is a different symbol entirely.
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
        # Space form: `--arthack-profile foo`.
        (["--arthack-profile", "foo"], [], "foo"),
        # Equals form: `--arthack-profile=foo`.
        (["--arthack-profile=foo"], [], "foo"),
        # Flag absent: everything passes through, profile is None.
        (["--model", "opus", "--print"], ["--model", "opus", "--print"], None),
        # Empty input.
        ([], [], None),
        # Interleaved with passthrough args (space form).
        (
            ["--model", "opus", "--arthack-profile", "foo", "--print"],
            ["--model", "opus", "--print"],
            "foo",
        ),
        # Interleaved with passthrough args (equals form).
        (
            ["--model", "opus", "--arthack-profile=foo", "--print"],
            ["--model", "opus", "--print"],
            "foo",
        ),
        # Multiple occurrences: last wins (space form).
        (
            ["--arthack-profile", "foo", "--arthack-profile", "bar"],
            [],
            "bar",
        ),
        # Multiple occurrences: last wins (mixed forms).
        (
            ["--arthack-profile=foo", "--arthack-profile", "bar"],
            [],
            "bar",
        ),
        # Trailing `--arthack-profile` with no value: there's no `i+1` and it
        # doesn't match the `=` prefix, so it falls through to passthrough and
        # profile stays None.
        (["--arthack-profile"], ["--arthack-profile"], None),
        # No-value trailing flag after real passthrough args.
        (
            ["--model", "opus", "--arthack-profile"],
            ["--model", "opus", "--arthack-profile"],
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
