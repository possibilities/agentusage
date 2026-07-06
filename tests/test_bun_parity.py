"""Parse-bridge parity: the Bun parsers must match the authoritative Python ones.

For every corpus case AND every importable inline parser fixture from the
existing parser-test modules, this runs the canonical Python ``parse(text,
now=pinned)`` IN-PROCESS and the Bun ``src/parse-bridge.ts`` as a subprocess with
the same ``--now``, then asserts:

- on a successful parse — the bridge's JSON deep-equals the Python usage dict;
- on a raise — the bridge's ``error_type`` equals the Python exception class name
  (the two runtimes name these identically: ClaudeUsageParseError,
  ClaudeUsageEndpointRateLimited, NoActiveSubscription, CodexStatusParseError).

Input is the parser-facing screen text, not the live drivers: corpus transcripts
are rendered through the same pyte path the CLI uses, so this isolates *parser*
parity (the dual-run module covers the tmux/pexpect drivers end-to-end).

Claude reprojects reset times to the system zone (Python ``.astimezone()`` /
Temporal ``Now.timeZoneId()``), so each comparison pins ``TZ`` for both sides;
codex keeps ``now``'s own fixed offset and is ``TZ``-independent. Skips when bun
is absent unless AGENTUSAGE_REQUIRE_PARITY=1 promotes the skip to a failure.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from typing import Iterator

import pytest

from conftest import (
    BRIDGE,
    REPO_ROOT,
    gate_bun,
    iter_corpus_cases,
    render_transcript,
)

sys.path.insert(0, str(REPO_ROOT))

import parse_claude_usage  # noqa: E402
import parse_codex_status  # noqa: E402
import test_parse_claude_usage as claude_fx  # noqa: E402
import test_parse_codex_status as codex_fx  # noqa: E402

_PARSERS = {
    "claude": parse_claude_usage.parse,
    "codex": parse_codex_status.parse,
}

# The inline claude fixtures resolve in this zone (their NOW is defined in it);
# codex fixtures carry a fixed offset and ignore it.
_INLINE_TZ = "America/New_York"
_CLAUDE_NOW = claude_fx.NOW.isoformat()
_CODEX_NOW = codex_fx.NOW.isoformat()


@contextlib.contextmanager
def _pinned_tz(tz: str) -> Iterator[None]:
    """Pin the process TZ (and restore it) so the in-process claude parse's
    ``.astimezone()`` matches the offset the bridge subprocess renders under."""
    prev = os.environ.get("TZ")
    os.environ["TZ"] = tz
    time.tzset()
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = prev
        time.tzset()


def _run_bridge(target: str, text: str, now: str) -> dict:
    """Feed screen text through the Bun parse-bridge; return its one JSON line."""
    proc = subprocess.run(
        [*BRIDGE, "--target", target, "--now", now],
        input=text,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=30,
        check=False,
    )
    assert proc.returncode in (0, 1), (
        f"parse-bridge crashed (rc={proc.returncode}); stderr:\n{proc.stderr}"
    )
    out = proc.stdout
    assert out.endswith("\n") and out.count("\n") == 1, (
        f"bridge must print exactly one JSON line: {out!r}"
    )
    return json.loads(out)


def _assert_parity(target: str, text: str, now: str, tz: str) -> None:
    """Assert Python (in-process) and the Bun bridge agree on one screen text."""
    with _pinned_tz(tz):
        try:
            expected: object = _PARSERS[target](text, now=datetime.fromisoformat(now))
            py_error: str | None = None
        except Exception as exc:  # noqa: BLE001 — any parser raise maps to error_type
            expected = None
            py_error = type(exc).__name__
        bridge = _run_bridge(target, text, now)

    if py_error is None:
        assert "error_type" not in bridge, (
            f"Python parsed but the bridge raised: {bridge}"
        )
        assert bridge == expected, (
            f"parse mismatch\n  python={expected}\n  bridge={bridge}"
        )
    else:
        assert "error_type" in bridge, (
            f"Python raised {py_error} but the bridge returned usage: {bridge}"
        )
        assert bridge["error_type"] == py_error, (
            f"error_type mismatch: python={py_error} bridge={bridge['error_type']}"
        )


# ---------- corpus cases ----------------------------------------------------

_CORPUS = iter_corpus_cases()


@pytest.mark.parametrize(
    "case_dir",
    [pytest.param(cd, id=name) for name, _meta, cd in _CORPUS],
)
def test_parse_bridge_matches_python_for_corpus(case_dir) -> None:
    gate_bun()
    meta = json.loads((case_dir / "case.json").read_text())
    text = render_transcript(
        (case_dir / "transcript.ansi").read_bytes(), meta["cols"], meta["rows"]
    )
    _assert_parity(meta["target"], text, meta["now"], meta["tz"])


# ---------- inline parser-test fixtures -------------------------------------

# Every module-level screen constant the parser-test modules feed to parse():
# subscribed/no-sub/rate-limit/depleted for claude, valid/spark/dated for codex.
_INLINE_FIXTURES = [
    ("claude", "SUBSCRIBED_SCREEN", claude_fx.SUBSCRIBED_SCREEN, _CLAUDE_NOW),
    ("claude", "SUBSCRIBED_WITH_SONNET", claude_fx.SUBSCRIBED_WITH_SONNET, _CLAUDE_NOW),
    ("claude", "DEPLETED_WEEK_SCREEN", claude_fx.DEPLETED_WEEK_SCREEN, _CLAUDE_NOW),
    ("claude", "NO_SUB_SCREEN", claude_fx.NO_SUB_SCREEN, _CLAUDE_NOW),
    (
        "claude",
        "API_BILLING_NO_BARS_SCREEN",
        claude_fx.API_BILLING_NO_BARS_SCREEN,
        _CLAUDE_NOW,
    ),
    (
        "claude",
        "API_BILLING_ENDPOINT_RATE_LIMIT_SCREEN",
        claude_fx.API_BILLING_ENDPOINT_RATE_LIMIT_SCREEN,
        _CLAUDE_NOW,
    ),
    ("codex", "VALID_PANEL", codex_fx.VALID_PANEL, _CODEX_NOW),
    ("codex", "SPARK_PANEL", codex_fx.SPARK_PANEL, _CODEX_NOW),
    ("codex", "LIVE_DATED_PANEL", codex_fx.LIVE_DATED_PANEL, _CODEX_NOW),
]


@pytest.mark.parametrize(
    "target, text, now",
    [
        pytest.param(t, txt, now, id=f"{t}-{name}")
        for t, name, txt, now in _INLINE_FIXTURES
    ],
)
def test_parse_bridge_matches_python_for_inline_fixtures(
    target: str, text: str, now: str
) -> None:
    gate_bun()
    _assert_parity(target, text, now, _INLINE_TZ)
