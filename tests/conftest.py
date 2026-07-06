"""Shared parity-harness support for the Bun-port conformance modules.

Home for the pieces `test_bun_parity.py` (parse-bridge parity) and
`test_dual_run_cli.py` (dual-CLI parity) both lean on, plus the skip discipline
that keeps a bun-or-tmux-absent host green while making the designated-
environment run non-vacuous:

- **Skip vs fail:** a parity dependency that is absent SKIPS with a reason by
  default, but `AGENTUSAGE_REQUIRE_PARITY=1` promotes every such skip to a
  failure — the gate that proves green isn't vacuous on this box. Route ALL
  environment skips through `skip_or_fail` so the promotion can't be bypassed.
- **Shared helpers:** corpus discovery, the pyte transcript render that mirrors
  `scrape.scrape`'s screen construction, the CLI/bridge argv prefixes, and the
  one-stdout-line contract check.

Purely additive: nothing here runs for the pre-existing modules (they use none
of these fixtures), so their behavior and the `-m "not live"` default are
untouched.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NoReturn

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SRC_DIR = REPO_ROOT / "src"
CORPUS_DIR = TESTS_DIR / "fixtures" / "corpus"
FAKE_TUI = TESTS_DIR / "fake-tui.ts"

# The scrape CLIs under comparison. Python is authoritative; the Bun port speaks
# the identical stdout contract. The bridge is the parse-only surface the
# parse-bridge parity module drives.
PY_CLI = [sys.executable, "-m", "agentusage.scrape_cli"]
BUN_CLI = ["bun", str(SRC_DIR / "scrape-cli.ts")]
BRIDGE = ["bun", str(SRC_DIR / "parse-bridge.ts")]

# The fake TUI enters the alternate screen on boot before replaying a transcript;
# the corpus stores the post-alt-screen bytes, so the render must prepend it to
# mirror scrape.scrape's screen construction (and the corpus generator's).
_ALT_SCREEN_ENTER = b"\x1b[?1049h"


# ---------- environment probing --------------------------------------------


def has_bun() -> bool:
    return shutil.which("bun") is not None


def has_tmux() -> bool:
    return shutil.which("tmux") is not None


def _require_parity() -> bool:
    """True when the designated-environment gate is armed.

    `AGENTUSAGE_REQUIRE_PARITY=1` promotes every reasoned skip in the parity
    modules to a failure so a host that quietly lacks bun/tmux can't report a
    vacuously-green parity run.
    """
    return os.environ.get("AGENTUSAGE_REQUIRE_PARITY") == "1"


def skip_or_fail(reason: str) -> NoReturn:
    """Skip by default; fail under AGENTUSAGE_REQUIRE_PARITY=1.

    The single choke point for parity-environment skips. Under the gate an
    absent dependency is a hard failure (the run is meant to prove parity here),
    otherwise it is a documented skip that keeps unequipped hosts green.
    """
    if _require_parity():
        pytest.fail(f"AGENTUSAGE_REQUIRE_PARITY=1 but parity is unavailable: {reason}")
    pytest.skip(reason)


def gate_bun() -> None:
    """Gate the parse-bridge parity module on a usable bun.

    Called from the test body (not a fixture) so the AGENTUSAGE_REQUIRE_PARITY
    promotion surfaces as a real test FAILURE rather than a setup error.
    """
    if not has_bun():
        skip_or_fail("bun is not installed (parse-bridge parity needs it)")


def gate_bun_and_tmux() -> None:
    """Gate the dual-run module on bun (the port) AND tmux (its scrape driver)."""
    gate_bun()
    if not has_tmux():
        skip_or_fail("tmux is not installed (the Bun scrape driver needs it)")


# ---------- corpus + render helpers ----------------------------------------


def iter_corpus_cases() -> list[tuple[str, dict, Path]]:
    """Every corpus scenario as (name, case_meta, case_dir), sorted by name."""
    cases: list[tuple[str, dict, Path]] = []
    for case_dir in sorted(p for p in CORPUS_DIR.iterdir() if p.is_dir()):
        meta = json.loads((case_dir / "case.json").read_text())
        cases.append((case_dir.name, meta, case_dir))
    return cases


def render_transcript(transcript: bytes, cols: int, rows: int) -> str:
    """Render a corpus transcript to the parser-facing screen text.

    Mirrors scrape.scrape / the corpus generator: feed the fake's alt-screen
    enter byte then the stored transcript through pyte at the pinned geometry
    and newline-join the per-row rstripped display. Isolates parser parity from
    the live PTY/tmux drivers (the dual-run module covers those end-to-end).
    """
    import pyte

    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    stream.feed(_ALT_SCREEN_ENTER + transcript)
    return "\n".join(line.rstrip() for line in screen.display)


# ---------- stdout contract -------------------------------------------------


def parse_one_json_line(stdout: str) -> dict:
    """Assert stdout is exactly one JSON object + trailing newline; return it.

    The wire contract keeper parses is ONE line: no banner, no second object,
    and a terminating newline. Mirrors test_scrape_cli._capture at the
    subprocess level for both CLIs.
    """
    assert stdout, "expected one JSON object on stdout, got nothing"
    assert stdout.endswith("\n"), f"stdout must end with a newline: {stdout!r}"
    body = stdout[:-1]
    assert "\n" not in body, f"expected exactly one stdout line, got: {stdout!r}"
    return json.loads(body)


# The fake TUI must outlive the driver's whole scrape or the tmux driver captures
# a dead pane. The pexpect driver's worst case (two 15s sentinel timeouts on a
# never-appearing panel) is ~40s; hold the fake well past that but under the
# per-CLI subprocess timeout so a genuine wedge still self-exits and returns.
_FAKE_MAX_SECONDS = "90"
_CLI_TIMEOUT = 120.0


def run_scrape_cli(
    cli: list[str],
    argv: list[str],
    *,
    case_dir: Path,
    now: str,
    tz: str,
    home: Path,
    extra_env: dict[str, str] | None = None,
    timeout: float = _CLI_TIMEOUT,
) -> subprocess.CompletedProcess[str]:
    """Invoke a scrape CLI against a fake-TUI corpus case with pinned clock/env.

    Sandboxes HOME (trust-file writes land in the sandbox, mirroring the
    writes-no-state test) and pins AGENTUSAGE_NOW + TZ so both runtimes resolve
    reset times against the identical instant. The fake TUI is appended via
    --command and selected by AGENTUSAGE_FAKE_CASE.
    """
    env = os.environ.copy()
    env["AGENTUSAGE_FAKE_CASE"] = str(case_dir)
    env["AGENTUSAGE_NOW"] = now
    env["TZ"] = tz
    env["HOME"] = str(home)
    env["AGENTUSAGE_FAKE_MAX_SECONDS"] = _FAKE_MAX_SECONDS
    # Never let an inherited gate leak into the child CLI's own environment.
    env.pop("AGENTUSAGE_REQUIRE_PARITY", None)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [*cli, *argv, "--command", str(FAKE_TUI)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
        timeout=timeout,
        check=False,
    )


def run_both_clis(
    argv: list[str],
    *,
    case_dir: Path,
    now: str,
    tz: str,
    extra_env: dict[str, str] | None = None,
    timeout: float = _CLI_TIMEOUT,
) -> tuple[subprocess.CompletedProcess[str], subprocess.CompletedProcess[str]]:
    """Run the Python and Bun CLIs concurrently against one case; return (py, bun).

    Each CLI gets its own HOME sandbox and an isolated driver (pexpect vs a tmux
    session), so they run in parallel with no shared state — a no-appear case
    costs max(py, bun), not their sum. Returns the completed processes for the
    caller to diff.
    """
    with (
        tempfile.TemporaryDirectory() as home_py,
        tempfile.TemporaryDirectory() as home_bun,
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        futures = {
            "py": pool.submit(
                run_scrape_cli,
                PY_CLI,
                argv,
                case_dir=case_dir,
                now=now,
                tz=tz,
                home=Path(home_py),
                extra_env=extra_env,
                timeout=timeout,
            ),
            "bun": pool.submit(
                run_scrape_cli,
                BUN_CLI,
                argv,
                case_dir=case_dir,
                now=now,
                tz=tz,
                home=Path(home_bun),
                extra_env=extra_env,
                timeout=timeout,
            ),
        }
        return futures["py"].result(), futures["bun"].result()
