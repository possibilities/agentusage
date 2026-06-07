"""Regression guard for the codex /status panel parser.

Covers the full `parse` happy path plus the two reset-time resolvers
(`_resolve_today_time`, `_resolve_date_time`) and every strict error path.
The load-bearing subtlety is the `percent_used == 100 - pct_left` inversion:
the panel reports percent *left*, the envelope stores percent *used*.

Codex resolves reset times against the system-local timezone via
`now.replace(...)` (NOT a ZoneInfo conversion), so the pinned `now` carries an
explicit fixed offset and the assertions pin that same offset. The date is
mid-month so `now.replace(month=..., day=...)` in `_resolve_date_time` never
trips a month-length `ValueError` unrelated to the code under test.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install (pyproject sets `tool.uv.package = false`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parse_codex_status import (  # noqa: E402
    CodexStatusParseError,
    _resolve_date_time,
    _resolve_today_time,
    parse,
)


# Fixed-offset tz so reset assertions are deterministic across machines/DST.
TZ = timezone(timedelta(hours=-4))
# Mid-month, mid-day pin: day=15 keeps `_resolve_date_time`'s month rewrite
# off any month-length boundary; 12:00 leaves room on both sides of "now" to
# exercise the today-vs-tomorrow roll without wrapping the date.
NOW = datetime(2026, 5, 15, 12, 0, tzinfo=TZ)


# Captured shape of the codex /status panel: the "5h limit:" / "Weekly limit:"
# rows the parser keys on, each reporting percent *left* with a reset clock.
VALID_PANEL = """\
│  Token usage:  1,234 used
│
│  5h limit:   [████░░░░] 99% left (resets 14:05)
│  Weekly limit:  [██░░░░░░] 29% left (resets 18:28 on 30 May)
│
│  Esc to dismiss
"""


def test_parse_valid_panel_inverts_percent_for_both_windows() -> None:
    """`percent_used` is the inversion of the reported percent-left for both
    the 5h and weekly windows — the easy-to-break bit."""
    out = parse(VALID_PANEL, now=NOW)
    assert set(out) == {"session", "week"}
    assert out["session"]["percent_used"] == 100 - 99  # 1
    assert out["week"]["percent_used"] == 100 - 29  # 71


def test_parse_valid_panel_resolves_resets_at_with_pinned_offset() -> None:
    """Reset times resolve in `now`'s own fixed offset (codex uses local tz)."""
    out = parse(VALID_PANEL, now=NOW)
    # 14:05 today is after 12:00 now → stays today, same -04:00 offset.
    assert (
        out["session"]["resets_at"]
        == datetime(2026, 5, 15, 14, 5, tzinfo=TZ).isoformat()
    )
    # 18:28 on 30 May this year is still future → stays this year.
    assert (
        out["week"]["resets_at"] == datetime(2026, 5, 30, 18, 28, tzinfo=TZ).isoformat()
    )


def test_parse_missing_sentinel_raises() -> None:
    """No `5h limit:` sentinel at all → strict parse error (panel changed)."""
    with pytest.raises(CodexStatusParseError):
        parse("some unrelated status screen with no limit rows", now=NOW)


def test_parse_sentinel_present_but_malformed_five_hour_row_raises() -> None:
    """Sentinel present but the 5h row doesn't match the percent/reset shape."""
    text = """\
│  5h limit:   [████] usage looks weird here
│  Weekly limit:  [██░░] 29% left (resets 18:28 on 30 May)
"""
    with pytest.raises(CodexStatusParseError):
        parse(text, now=NOW)


def test_parse_missing_weekly_row_raises() -> None:
    """Valid 5h row but the weekly row is absent → strict parse error."""
    text = "│  5h limit:   [████] 99% left (resets 14:05)\n"
    with pytest.raises(CodexStatusParseError):
        parse(text, now=NOW)


def test_parse_malformed_weekly_row_raises() -> None:
    """Weekly sentinel present but missing the `on DD Mon` date tail."""
    text = """\
│  5h limit:   [████] 99% left (resets 14:05)
│  Weekly limit:  [██░░] 29% left (resets 18:28)
"""
    with pytest.raises(CodexStatusParseError):
        parse(text, now=NOW)


def test_resolve_today_time_passed_rolls_to_tomorrow() -> None:
    """An HH:MM already passed today rolls forward one day."""
    # 09:30 < 12:00 now → tomorrow.
    resolved = _resolve_today_time(9, 30, NOW)
    assert resolved == datetime(2026, 5, 16, 9, 30, tzinfo=TZ)


def test_resolve_today_time_future_stays_today() -> None:
    """An HH:MM still ahead of now stays on today's date."""
    # 14:05 > 12:00 now → today.
    resolved = _resolve_today_time(14, 5, NOW)
    assert resolved == datetime(2026, 5, 15, 14, 5, tzinfo=TZ)


def test_resolve_today_time_exactly_now_rolls_to_tomorrow() -> None:
    """A time equal to now is `<= now` and rolls to tomorrow."""
    resolved = _resolve_today_time(12, 0, NOW)
    assert resolved == datetime(2026, 5, 16, 12, 0, tzinfo=TZ)


def test_resolve_date_time_passed_this_year_rolls_to_next_year() -> None:
    """A date already passed this year resolves to next year."""
    # 1 Jan is well before 15 May now → 2027.
    resolved = _resolve_date_time(1, "Jan", 10, 0, NOW)
    assert resolved == datetime(2027, 1, 1, 10, 0, tzinfo=TZ)


def test_resolve_date_time_future_stays_this_year() -> None:
    """A date still ahead this year stays in the current year."""
    resolved = _resolve_date_time(30, "May", 18, 28, NOW)
    assert resolved == datetime(2026, 5, 30, 18, 28, tzinfo=TZ)


def test_resolve_date_time_unknown_month_raises() -> None:
    """An unparseable month name raises the strict parse error."""
    with pytest.raises(CodexStatusParseError):
        _resolve_date_time(10, "Smarch", 12, 0, NOW)
