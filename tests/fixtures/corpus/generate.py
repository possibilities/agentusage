#!/usr/bin/env python3
"""Regenerate the conformance corpus both runtimes consume.

The corpus is the versioned cross-runtime contract: one directory per scenario
carrying the raw ANSI transcript the fake TUI replays, the frozen pyte-rendered
``screen.txt`` the parsers consume, the pinned ``now`` / ``TZ`` and CLI argv
shape, and the expected discriminated-contract JSON + exit code.

Canonical implementation is Python: expected outputs are GENERATED here by
feeding each transcript through the real pyte render path (mirroring
``scrape.scrape``'s screen construction) and the real parser / CLI arm-builders
(``agentusage.scrape_cli``) under the pinned clock — never hand-written. Claude
reset times resolve in the system-local zone (``datetime.astimezone()``), so
generation pins ``TZ`` per case; codex keeps ``now``'s own offset. Once the CLI
gains its ``now`` injection seam (a later task), the exact same expected JSON is
reproducible end-to-end by running the CLI with that clock pinned.

Screen fixtures below mirror the inline fixtures in the parser test modules
(``test_parse_claude_usage.py`` / ``test_parse_codex_status.py``); real
identifiers are scrubbed length-loosely (every scenario here renders at wide
cols where wrapping is irrelevant, except the structural wrap-split case which
carries no secret to scrub).

Run: ``uv run python tests/fixtures/corpus/generate.py``.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

_CORPUS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _CORPUS_DIR.parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pyte  # noqa: E402

import parse_claude_usage  # noqa: E402
import parse_codex_status  # noqa: E402
import scrape  # noqa: E402
from agentusage import scrape_cli  # noqa: E402

_ALT_SCREEN_ENTER = b"\x1b[?1049h"

# Default pinned geometry — the scrape defaults (scrape.COLS/ROWS). Wide enough
# that no wrapping occurs, so the parsers see each panel row intact.
_WIDE_COLS, _WIDE_ROWS = scrape.COLS, scrape.ROWS

_CLAUDE_NOW = "2026-05-29T12:00:00-04:00"
_CLAUDE_TZ = "America/New_York"
_CODEX_NOW = "2026-05-15T12:00:00-04:00"
_CODEX_TZ = "America/New_York"


# ---------- Screen fixtures (mirror the inline parser-test fixtures) ---------

SUBSCRIBED = """\
  Settings  Status   Config   Usage   Stats

  Current session
  [████████░░░░░░░░] 42% used
  Resets 3pm (America/New_York)

  Current week (all models)
  [██░░░░░░░░░░░░░░] 17% used
  Resets May 31 at 9am (America/New_York)
"""

SUBSCRIBED_WITH_SONNET = (
    SUBSCRIBED
    + """
  Current week (Sonnet only)
  [█░░░░░░░░░░░░░░░] 9% used
  Resets May 31 at 9am (America/New_York)
"""
)

DEPLETED_WEEK = """\
  Settings  Status   Config   Usage   Stats

  Current session
                                  0% used
  Current week (all models)
  [██████████████████] 100% used
  Resets Jun 13 at 3:59am (America/New_York)
"""

NO_SUB = """\
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

   d to day · w to week
   Esc to cancel
"""

# Email scrubbed to a clearly-fake placeholder (no real account / org identifier).
API_BILLING = """\
╭─── Claude Code v2.1.195 ─────────────────────────────────────────────
│ Opus 4.8 (1M context) with xh… · API Usage Billing │
│ · scrubbed-account@example.test's Organization      │
╰──────────────────────────────────────────────────────────────────────
   Settings  Status   Config   usage   Stats
   Session
   Total cost:            $0.0000
   Usage:                 0 input, 0 output, 0 cache read, 0 cache write
   Esc to cancel
"""

API_BILLING_ENDPOINT_RATE_LIMIT = (
    API_BILLING
    + """\
   Error: Usage endpoint is rate limited. Please try again in a moment.
   r to retry · Esc to cancel
"""
)

# OAuth sign-in screen — three sentinels (banner + authorize URL + paste prompt)
# clear the scraper's 2-of-3 pre-send quorum. client_id scrubbed.
SIGNED_OUT = """\
  Welcome to Claude Code

  Sign in to continue

  Browser didn't open? Visit:
  https://claude.ai/oauth/authorize?client_id=scrubbed&scope=read

  Paste code here >
"""

# Structural: at cols=30 the authorize URL wraps mid-token so "/oauth/authorize"
# lands on no single row, yet the dewrapped corpus reconstructs it (paired with
# the paste prompt = 2-of-3). No secret, so scrubbing cannot shift the wrap seam.
WRAP_SPLIT_SIGNED_OUT = """\
Visit https://claude.ai/oauth/authorize?code=1
Paste code here >
"""

# Panel never rendered: a home screen with no /usage tab strip, no bars, and only
# one OAuth sentinel (below quorum) — the parser sees none of the screen it needs.
PANEL_MISSING = """\
  Welcome to Claude Code

  Tips for getting started:
  1. Run /help for a list of commands
  2. Ask questions about your code
"""

# Format drift: the /usage panel header and the weekly bar rendered, but the
# session percent line is malformed — real drift the strict parser must reject.
FORMAT_DRIFT = """\
  Settings  Status   Config   Usage   Stats

  Current session
  usage is unavailable
  Resets 3pm (America/New_York)

  Current week (all models)
  [██░░░░░░░░░░░░░░] 17% used
  Resets May 31 at 9am (America/New_York)
"""

CODEX_OK = """\
│  Token usage:  1,234 used
│
│  5h limit:   [████░░░░] 99% left (resets 14:05)
│  Weekly limit:  [██░░░░░░] 29% left (resets 18:28 on 30 May)
│
│  Esc to dismiss
"""

CODEX_SPARK = """\
│  Token usage:  1,234 used
│
│  5h limit:   [████░░░░] 99% left (resets 14:05)
│  Weekly limit:  [██░░░░░░] 29% left (resets 18:28 on 30 May)
│  GPT-5.3-Codex-Spark limit:
│  5h limit:   [████░░░░] 73% left (resets 23:59)
│  Weekly limit:  [██░░░░░░] 52% left (resets 21:00 on 28 Jun)
│
│  Esc to dismiss
"""

# Weekly drift: every row (primary + Spark) carries an `on DD Mon` tail — the
# live shape that broke the old date-less-5h / dated-weekly split. Parses clean.
CODEX_WEEKLY_DRIFT = """\
│  5h limit:                    [████████████████████] 98% left (resets 01:18 on 29 Jun)
│  Weekly limit:                [████████████████████] 100% left (resets 20:18 on 5 Jul)
│  GPT-5.3-Codex-Spark limit:
│  5h limit:                    [████████████████████] 100% left (resets 01:28 on 29 Jun)
│  Weekly limit:                [████████████████████] 100% left (resets 20:28 on 5 Jul)
"""


def _text_to_bytes(text: str) -> bytes:
    """Encode fixture text as the fake TUI replays it: CR+LF row breaks so pyte
    returns each line to column 0 (a bare LF only moves down)."""
    return "\r\n".join(text.splitlines()).encode()


def _spinner_transcript(panel_text: str) -> bytes:
    """A byte-active-but-snapshot-stable case: paint the subscribed panel, then
    animate a spinner on a scratch row and clear it, so the final rendered
    snapshot equals the plain panel while the byte stream stays busy."""
    out = bytearray(_text_to_bytes(panel_text))
    for frame in "⠋⠙⠹⠸⠼⠴⠦⠧":
        out += b"\x1b[12;1H"  # absolute move to an empty scratch row
        out += frame.encode()
    out += b"\x1b[12;1H\x1b[2K"  # clear the scratch row: snapshot back to stable
    return bytes(out)


# ---------- Scenario table --------------------------------------------------


# Each scenario: name, target, transcript bytes, argv (WITHOUT --command, which
# the harness sets to the fake TUI at runtime), pinned now/tz, geometry, whether
# the panel paints pre-send (signed-out screens the scraper classifies before it
# ever types the slash), the auth-probe `loggedIn` answer, and a description.
def _scenarios() -> list[dict]:
    def claude(
        name,
        transcript,
        *,
        argv_extra=None,
        paint_on_boot=False,
        logged_in=True,
        cols=_WIDE_COLS,
        rows=_WIDE_ROWS,
        desc="",
    ):
        return {
            "name": name,
            "target": "claude",
            "transcript": transcript,
            "argv": ["--target", "claude", "--profile", "default", *(argv_extra or [])],
            "now": _CLAUDE_NOW,
            "tz": _CLAUDE_TZ,
            "cols": cols,
            "rows": rows,
            "paint_on_boot": paint_on_boot,
            "logged_in": logged_in,
            "description": desc,
        }

    def codex(name, transcript, *, desc=""):
        return {
            "name": name,
            "target": "codex",
            "transcript": transcript,
            "argv": ["--target", "codex", "--profile", "default"],
            "now": _CODEX_NOW,
            "tz": _CODEX_TZ,
            "cols": _WIDE_COLS,
            "rows": _WIDE_ROWS,
            "paint_on_boot": False,
            "logged_in": True,
            "description": desc,
        }

    return [
        claude(
            "claude-subscribed",
            _text_to_bytes(SUBSCRIBED),
            desc="subscribed account: session + weekly rate-limit bars",
        ),
        claude(
            "claude-subscribed-sonnet",
            _text_to_bytes(SUBSCRIBED_WITH_SONNET),
            desc="subscribed with the optional Sonnet-only weekly bar",
        ),
        claude(
            "claude-depleted-week",
            _text_to_bytes(DEPLETED_WEEK),
            desc="weekly cap hit: 0% null-reset session, 100% week",
        ),
        claude(
            "claude-no-subscription",
            _text_to_bytes(NO_SUB),
            desc="no active subscription: usage-contribution breakdown, no bars",
        ),
        claude(
            "claude-api-billing",
            _text_to_bytes(API_BILLING),
            desc="API-billing org: no bars, treated as no-subscription",
        ),
        claude(
            "claude-endpoint-rate-limited",
            _text_to_bytes(API_BILLING_ENDPOINT_RATE_LIMIT),
            desc="transient /usage endpoint rate-limit error",
        ),
        claude(
            "claude-signed-out",
            _text_to_bytes(SIGNED_OUT),
            paint_on_boot=True,
            desc="logged-out OAuth sign-in screen, classified pre-send",
        ),
        claude(
            "claude-wrap-split-signed-out",
            _text_to_bytes(WRAP_SPLIT_SIGNED_OUT),
            argv_extra=["--rows", "24", "--cols", "30"],
            paint_on_boot=True,
            cols=30,
            rows=24,
            desc="structural: narrow-cols wrap-split OAuth URL sentinel",
        ),
        claude(
            "claude-panel-missing",
            _text_to_bytes(PANEL_MISSING),
            desc="panel never rendered: no tab strip, no bars",
        ),
        claude(
            "claude-format-drift",
            _text_to_bytes(FORMAT_DRIFT),
            desc="panel rendered but the session percent line drifted",
        ),
        claude(
            "claude-spinner-snapshot-stable",
            _spinner_transcript(SUBSCRIBED),
            desc="structural: byte-active spinner over a stable subscribed snapshot",
        ),
        codex(
            "codex-ok",
            _text_to_bytes(CODEX_OK),
            desc="codex /status: 5h + weekly limit rows",
        ),
        codex(
            "codex-ok-spark",
            _text_to_bytes(CODEX_SPARK),
            desc="codex /status with the optional Codex-Spark bucket",
        ),
        codex(
            "codex-weekly-drift",
            _text_to_bytes(CODEX_WEEKLY_DRIFT),
            desc="codex live drift: every row carries an `on DD Mon` tail",
        ),
    ]


# ---------- Expected-output generation (canonical Python) --------------------


def _render(transcript: bytes, cols: int, rows: int):
    """Mirror scrape.scrape's screen construction: alt-screen enter (the fake's
    boot byte) then the transcript, fed through pyte at the pinned geometry."""
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    stream.feed(_ALT_SCREEN_ENTER + transcript)
    rendered = "\n".join(line.rstrip() for line in screen.display)
    return screen, rendered


def _expected(scenario: dict) -> tuple[dict, int]:
    """Reproduce the CLI's run() branching over the rendered screen under the
    pinned clock — the same discriminated arm + exit code the CLI emits."""
    target = scenario["target"]
    now = datetime.fromisoformat(scenario["now"])
    screen, rendered = _render(
        scenario["transcript"], scenario["cols"], scenario["rows"]
    )

    # Pre-send sign-in gate: scrape() raises SignedOut before the parser ever
    # runs, so a claude case whose alt-screen shows the OAuth quorum is the
    # signed_out success arm regardless of what the parser would say.
    if target == "claude" and scrape._detect_signed_out(
        screen, scrape.TARGETS["claude"]["signed_out_sentinels"]
    ):
        return scrape_cli._ok_signed_out(), 0

    parser = scrape_cli.PARSERS[target]
    try:
        usage = parser(rendered, now=now)
    except parse_claude_usage.NoActiveSubscription:
        # The CLI confirms a logged-out profile via `claude auth status`; the
        # fake TUI answers with this case's `logged_in`.
        if target == "claude" and scenario["logged_in"] is False:
            return scrape_cli._ok_signed_out(), 0
        return scrape_cli._ok_no_subscription(), 0
    except (
        parse_claude_usage.ClaudeUsageEndpointRateLimited,
        parse_claude_usage.ClaudeUsageParseError,
        parse_codex_status.CodexStatusParseError,
    ) as exc:
        kind = scrape_cli._classify_parse_error(target, exc, rendered)
        payload = scrape_cli._error(
            type(exc).__name__, str(exc), scrape_cli._screen_excerpt(rendered), kind
        )
        return payload, 1

    subscription_active = True if target == "claude" else None
    return scrape_cli._ok_subscribed(usage, subscription_active), 0


def _write_case(scenario: dict) -> None:
    case_dir = _CORPUS_DIR / scenario["name"]
    case_dir.mkdir(parents=True, exist_ok=True)

    (case_dir / "transcript.ansi").write_bytes(scenario["transcript"])

    # Freeze the pyte-rendered screen the parsers consume, so the corpus stays
    # self-sufficient once Python is gone: the bun parse-conformance module and
    # generate.ts re-derive expected.json from this frozen text, subprocess- and
    # tmux-free. It is exactly the text scrape.scrape hands the parser (newline-
    # joined rstripped display) plus a trailing newline the readers strip back.
    _, rendered = _render(scenario["transcript"], scenario["cols"], scenario["rows"])
    (case_dir / "screen.txt").write_text(rendered + "\n")

    payload, exit_code = _expected(scenario)
    (case_dir / "expected.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    )

    case_meta = {
        "schema_version": 1,
        "description": scenario["description"],
        "target": scenario["target"],
        "argv": scenario["argv"],
        "now": scenario["now"],
        "tz": scenario["tz"],
        "cols": scenario["cols"],
        "rows": scenario["rows"],
        "paint_on_boot": scenario["paint_on_boot"],
        "mount_delay_ms": 0,
        "logged_in": scenario["logged_in"],
        "expected_exit_code": exit_code,
    }
    (case_dir / "case.json").write_text(
        json.dumps(case_meta, indent=2, ensure_ascii=False) + "\n"
    )


def main() -> int:
    # Claude reset times resolve in the system-local zone; pin it so the corpus
    # is portable. Codex keeps now's own offset, so this is a no-op for it.
    os.environ["TZ"] = _CLAUDE_TZ
    time.tzset()

    scenarios = _scenarios()
    for scenario in scenarios:
        _write_case(scenario)
    print(f"generated {len(scenarios)} corpus cases under {_CORPUS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
