"""Coverage for the pure daemon helpers.

All four helpers are pure (or pure given an isolated home), so these are fast
table-driven tests. ``_resolve_multiplier`` reads the real filesystem at call
time, so the test isolates ``daemon.Path.home`` to a ``tmp_path`` before calling
— otherwise it's non-hermetic (and reads the developer's actual profiles).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install. Mirrors the sibling test files' pattern.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import daemon  # noqa: E402


# ---------- _parse_aware_isoformat -----------------------------------------


def test_parse_aware_isoformat_aware() -> None:
    raw = "2026-06-15T09:00:00-04:00"
    parsed = daemon._parse_aware_isoformat(raw)
    assert isinstance(parsed, datetime)
    assert parsed.tzinfo is not None
    assert parsed == datetime.fromisoformat(raw)


def test_parse_aware_isoformat_naive_returns_none() -> None:
    # Naive stamp (no offset) is treated as a corrupted envelope → None.
    assert daemon._parse_aware_isoformat("2026-06-15T09:00:00") is None


@pytest.mark.parametrize(
    "raw",
    [
        "not-a-timestamp",
        "",
        "2026-13-99T99:99:99+00:00",
    ],
)
def test_parse_aware_isoformat_garbage_returns_none(raw: str) -> None:
    assert daemon._parse_aware_isoformat(raw) is None


@pytest.mark.parametrize("raw", [None, 42, 3.14, ["2026-06-15T09:00:00+00:00"]])
def test_parse_aware_isoformat_non_str_returns_none(raw: object) -> None:
    assert daemon._parse_aware_isoformat(raw) is None


# ---------- _resolve_multiplier --------------------------------------------


def _write_claude_json(home: Path, profile: str, payload: object) -> None:
    """Write a profile's ``.claude.json`` under an isolated home dir."""
    pdir = home / ".claude-profiles" / profile
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / ".claude.json").write_text(json.dumps(payload))


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        ("default_claude_ai", 1),
        ("default_claude_max_5x", 5),
        ("default_claude_max_20x", 20),
    ],
)
def test_resolve_multiplier_known_tier(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier: str, expected: int
) -> None:
    # Isolate the real-FS read: point Path.home at tmp_path BEFORE calling.
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    _write_claude_json(
        tmp_path, "prof", {"oauthAccount": {"organizationRateLimitTier": tier}}
    )
    assert daemon._resolve_multiplier("prof") == expected
    # Sanity-pin against the source-of-truth constant.
    assert daemon.TIER_MULTIPLIERS[tier] == expected


def test_resolve_multiplier_unknown_tier_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    _write_claude_json(
        tmp_path,
        "prof",
        {"oauthAccount": {"organizationRateLimitTier": "default_claude_max_99x"}},
    )
    assert daemon._resolve_multiplier("prof") == 1


def test_resolve_multiplier_missing_tier_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    _write_claude_json(tmp_path, "prof", {"oauthAccount": {}})
    assert daemon._resolve_multiplier("prof") == 1


def test_resolve_multiplier_missing_file_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No .claude.json written at all → OSError on stat → 1x fallback.
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    assert daemon._resolve_multiplier("nonexistent-profile") == 1


def test_resolve_multiplier_unreadable_json_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # File exists but holds garbage → JSONDecodeError → 1x fallback.
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    pdir = tmp_path / ".claude-profiles" / "prof"
    pdir.mkdir(parents=True)
    (pdir / ".claude.json").write_text("{ not valid json")
    assert daemon._resolve_multiplier("prof") == 1


def test_resolve_multiplier_oversize_file_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # File over MAX_CLAUDE_JSON_BYTES → 1x fallback without parsing.
    monkeypatch.setattr(daemon.Path, "home", lambda: tmp_path)
    pdir = tmp_path / ".claude-profiles" / "prof"
    pdir.mkdir(parents=True)
    payload = (
        '{"oauthAccount": {"organizationRateLimitTier": "default_claude_max_20x"}}'
    )
    pad = " " * (daemon.MAX_CLAUDE_JSON_BYTES + 1)
    (pdir / ".claude.json").write_text(payload + pad)
    assert daemon._resolve_multiplier("prof") == 1


# ---------- _screen_excerpt ------------------------------------------------


def test_screen_excerpt_under_max_verbatim() -> None:
    rendered = "alpha   \n\n  beta\n   \ngamma"
    # Blank/whitespace-only lines dropped; each surviving line rstripped.
    assert daemon._screen_excerpt(rendered, max_lines=24) == [
        "alpha",
        "  beta",
        "gamma",
    ]


def test_screen_excerpt_truncates_to_240_chars() -> None:
    long_line = "x" * 300
    [out] = daemon._screen_excerpt(long_line, max_lines=24)
    assert out == "x" * 240
    assert len(out) == 240


def test_screen_excerpt_over_max_head_tail_split() -> None:
    max_lines = 24
    # 30 nonblank lines → over the cap.
    rendered = "\n".join(f"line{i}" for i in range(30))
    out = daemon._screen_excerpt(rendered, max_lines=max_lines)

    head = max_lines // 2  # 12
    tail = max_lines - head - 1  # 11
    omitted = 30 - head - tail  # 7

    assert len(out) == max_lines  # 12 head + marker + 11 tail
    assert out[:head] == [f"line{i}" for i in range(head)]
    assert out[head] == f"... {omitted} lines omitted ..."
    assert out[head + 1 :] == [f"line{i}" for i in range(30 - tail, 30)]


# ---------- _build_envelope ------------------------------------------------


def test_build_envelope_key_set_and_schema_version() -> None:
    # Inline Account construction — copied from
    # tests/test_daemon_idle_stale_guard.py:296.
    acct: daemon.Account = {
        "id": "test-build-envelope",
        "target": "claude",
        "passthrough": [],
        "multiplier": 1,
    }
    env = daemon._build_envelope(
        acct,
        status="active",
        subscription_active=True,
        usage={"five_hour": {"used": 1, "limit": 10}},
        lift_at=None,
        last_successful_fetch_at="2026-06-15T09:00:00-04:00",
        last_skipped_fetch_at=None,
        last_failed_fetch_at=None,
        next_fetch_at="2026-06-15T09:02:00-04:00",
        error=None,
    )

    assert set(env.keys()) == set(daemon.ENVELOPE_KEYS)
    assert env["schema_version"] == daemon.ENVELOPE_SCHEMA_VERSION
    # The acct fields propagate verbatim.
    assert env["id"] == acct["id"]
    assert env["target"] == acct["target"]
    assert env["multiplier"] == acct["multiplier"]
    assert env["status"] == "active"
