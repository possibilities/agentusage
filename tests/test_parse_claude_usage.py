"""Regression guard for the two-axis no-subscription detection.

The detection is load-bearing for the envelope contract (it switches both
the parser's branch and the scrape sentinel's short-circuit). A silent
regression here means a no-sub account would either burn the full ~180s
sentinel timeout every cycle or never produce a main `<id>.json` again.

Kept lightweight: one file, two fixtures (no-sub breakdown screen, subscribed
bars screen), no live TUI, no network. The parser's `now=` injection makes
the subscribed case deterministic.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install (pyproject sets `tool.uv.package = false`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parse_claude_usage import (  # noqa: E402
    ClaudeUsageParseError,
    NoActiveSubscription,
    parse,
)


# Captured (and trimmed for fixture sanity) from the live multi-claude-1
# scrape: the /usage panel opens to the usage-contribution breakdown with
# NO rate-limit bars when an account has no active subscription. Header
# casing varies ("Usage" vs "usage") between scrapes — both render the
# same downstream content.
NO_SUB_SCREEN = """\
  Settings  Status   Config   usage   Stats

  What's contributing to your limits usage?

   Models                  % of usage
   Sonnet 4.6                     58%
   Opus 4.8                       21%
   Haiku 4.5                       8%

   Tools                   % of usage
   Bash                           34%
   Read                           18%
   Edit                            9%

   Plugins                 % of usage
   plan                           42%
   work                           11%
   arthack                         4%

   d to day · w to week
   Esc to cancel
"""


# Captured shape of a normal subscribed account's /usage panel: rate-limit
# bars with "% used" plus the Resets line each parser block keys on. Times
# resolve deterministically against the fixed `NOW` below.
SUBSCRIBED_SCREEN = """\
  Settings  Status   Config   Usage   Stats

  Current session
  [████████░░░░░░░░] 42% used
  Resets 3pm (America/New_York)

  Current week (all models)
  [██░░░░░░░░░░░░░░] 17% used
  Resets May 31 at 9am (America/New_York)
"""


SUBSCRIBED_WITH_SONNET = (
    SUBSCRIBED_SCREEN
    + """
  Current week (Sonnet only)
  [█░░░░░░░░░░░░░░░] 9% used
  Resets May 31 at 9am (America/New_York)
"""
)


NOW = datetime(2026, 5, 29, 12, 0, tzinfo=ZoneInfo("America/New_York"))


def test_no_subscription_screen_raises_no_active_subscription() -> None:
    """The no-sub breakdown must raise NoActiveSubscription, not the generic
    ClaudeUsageParseError. The daemon catches the former as a success and
    misses the distinction if this regresses."""
    with pytest.raises(NoActiveSubscription):
        parse(NO_SUB_SCREEN, now=NOW)


def test_subscribed_screen_parses_session_and_week() -> None:
    """The subscribed-bars path must keep returning the structured usage
    dict unchanged — the no-sub branching above this is purely additive."""
    out = parse(SUBSCRIBED_SCREEN, now=NOW)
    assert set(out) == {"session", "week"}
    assert out["session"]["percent_used"] == 42.0
    assert out["week"]["percent_used"] == 17.0
    # Resets resolve via the parser's now= injection — just confirm they
    # parsed to ISO8601 strings (precise reset semantics covered by the
    # parser's own logic, not in scope here).
    assert isinstance(out["session"]["resets_at"], str)
    assert isinstance(out["week"]["resets_at"], str)


def test_subscribed_screen_with_sonnet_includes_optional_block() -> None:
    """The optional sonnet_week block parses when present; this guards the
    case-insensitive header gate fix from regressing the optional path."""
    out = parse(SUBSCRIBED_WITH_SONNET, now=NOW)
    assert set(out) == {"session", "week", "sonnet_week"}
    assert out["sonnet_week"]["percent_used"] == 9.0


def test_empty_panel_raises_parse_error() -> None:
    """No bars AND no no-sub breakdown — real format drift or panel never
    rendered. Must surface as the strict ClaudeUsageParseError so the daemon
    treats it as a failure (status=stale), not a silent no-sub success."""
    with pytest.raises(ClaudeUsageParseError):
        parse("some unrelated screen with no bars and no breakdown", now=NOW)
