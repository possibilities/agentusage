"""Smoke coverage that the fake TUI drives the REAL scrape path end-to-end.

Not the parity module (that arrives with the Bun CLI) — this proves the
conformance harness is sound BEFORE the bun side exists: the fake TUI answers
the CLI's `auth status` probe with a configurable `loggedIn`, tolerates unknown
argv, and drives the real pexpect + pyte + parser stack to the expected ok arm
for a subscribed claude case and a codex case (whose `extra_args` exercise the
unknown-flag tolerance through the TUI path).

Kept offline and deterministic: the only child spawned is `tests/fake_tui.py`,
selected via the `--command` override and the `AGENTUSAGE_FAKE_CASE` env var.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _TESTS_DIR.parent
_FAKE_TUI = _TESTS_DIR / "fake_tui.py"
_CORPUS_DIR = _TESTS_DIR / "fixtures" / "corpus"


def _run_cli(case_name: str) -> subprocess.CompletedProcess[str]:
    """Invoke the real scrape CLI against a corpus case via the fake TUI."""
    case_dir = _CORPUS_DIR / case_name
    argv = json.loads((case_dir / "case.json").read_text())["argv"]
    env = os.environ.copy()
    env["AGENTUSAGE_FAKE_CASE"] = str(case_dir)
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "agentusage.scrape_cli",
            *argv,
            "--command",
            str(_FAKE_TUI),
        ],
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT,
        env=env,
        timeout=90,
        check=False,
    )


def _write_case(tmp_path: Path, *, logged_in: bool) -> Path:
    case_dir = tmp_path / "case"
    case_dir.mkdir()
    (case_dir / "case.json").write_text(json.dumps({"logged_in": logged_in}))
    (case_dir / "transcript.ansi").write_bytes(b"")
    return case_dir


@pytest.mark.parametrize("logged_in", [True, False])
def test_fake_tui_auth_status_reports_configured_logged_in(
    tmp_path: Path, logged_in: bool
) -> None:
    """`<fake> auth status` returns the case's configured loggedIn as JSON —
    the contract the CLI's no-bar auth probe reads."""
    case_dir = _write_case(tmp_path, logged_in=logged_in)
    env = os.environ.copy()
    env["AGENTUSAGE_FAKE_CASE"] = str(case_dir)
    proc = subprocess.run(
        [sys.executable, str(_FAKE_TUI), "auth", "status"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 0
    assert json.loads(proc.stdout.strip()) == {"loggedIn": logged_in}


def test_fake_tui_auth_status_ignores_unknown_flags(tmp_path: Path) -> None:
    """Unknown trailing argv on the auth probe is tolerated, not fatal."""
    case_dir = _write_case(tmp_path, logged_in=True)
    env = os.environ.copy()
    env["AGENTUSAGE_FAKE_CASE"] = str(case_dir)
    proc = subprocess.run(
        [sys.executable, str(_FAKE_TUI), "auth", "status", "--bogus-unknown-flag"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 0
    assert json.loads(proc.stdout.strip()) == {"loggedIn": True}


def test_cli_drives_subscribed_scenario_end_to_end() -> None:
    """The subscribed claude case drives the real pexpect + pyte + parser path
    through the fake TUI's paint-on-slash gate and returns the ok arm.

    Expected scalars are read by hand off the transcript (42% / 17% used), not
    re-derived by the parser under test."""
    proc = _run_cli("claude-subscribed")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip())
    assert payload["status"] == "ok"
    assert payload["subscription_active"] is True
    assert payload["usage"]["session"]["percent_used"] == 42.0
    assert payload["usage"]["week"]["percent_used"] == 17.0


def test_cli_drives_codex_scenario_end_to_end_ignoring_extra_args() -> None:
    """The codex case proves TUI-mode unknown-flag tolerance end-to-end: scrape
    prepends codex's `--dangerously-bypass-approvals-and-sandbox` extra_arg,
    which the fake TUI ignores. percent_used is 100 minus the hand-read
    percent-left (100-99, 100-29)."""
    proc = _run_cli("codex-ok")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip())
    assert payload["status"] == "ok"
    assert payload["subscription_active"] is None
    assert payload["usage"]["session"]["percent_used"] == 1
    assert payload["usage"]["week"]["percent_used"] == 71
