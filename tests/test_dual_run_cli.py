"""Dual-run CLI parity: the Bun CLI must match the authoritative Python CLI.

Drives BOTH scrape CLIs end-to-end through the SAME scripted fake TUI (the tmux
driver for Bun, pexpect for Python) under a pinned clock/TZ and a sandboxed HOME,
then asserts they speak the identical stdout contract:

- parsed-JSON deep-equality between the two runtimes AND against the committed
  ``expected.json`` (the corpus is the contract);
- exact ``resets_at`` strings (the today/tomorrow-roll risk fails loudly here,
  not as a whole-payload diff);
- exactly one stdout line with a trailing newline;
- matching exit codes (0 for every ok arm, 1 for the error arm).

Beyond the corpus scenarios (which already include the wrap-split and spinner
structural cases) it covers the CLI-level forks the parse layer can't: the no-bar
auth probe (loggedIn true / false / garbage), a mount-delay ready-wait race, and
a stubborn-child reaping case that proves each CLI's cleanup sweeps the whole
process group. Skips when bun or tmux is absent unless AGENTUSAGE_REQUIRE_PARITY=1
promotes the skip to a failure. One real-binary case carries the ``live`` marker
and is excluded by default.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import (
    BUN_CLI,
    CORPUS_DIR,
    PY_CLI,
    REPO_ROOT,
    gate_bun_and_tmux,
    iter_corpus_cases,
    parse_one_json_line,
    run_both_clis,
    run_scrape_cli,
)

# ---------- shared assertions ----------------------------------------------


def _reset_times(payload: dict) -> dict:
    """The {window: resets_at} map of an ok/subscribed payload, else empty.

    Isolated so a reset-boundary mismatch fails on its own crisp assertion rather
    than buried in a whole-payload diff (the two-subprocess clock-straddle risk).
    """
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return {}
    return {k: v.get("resets_at") for k, v in usage.items() if isinstance(v, dict)}


def _assert_contract_parity(
    py: subprocess.CompletedProcess[str],
    bun: subprocess.CompletedProcess[str],
    *,
    expected: dict,
    expected_exit: int,
) -> None:
    """Both CLIs emit one JSON line that deep-equals `expected` and each other,
    with matching reset strings and exit codes."""
    py_json = parse_one_json_line(py.stdout)
    bun_json = parse_one_json_line(bun.stdout)

    assert py_json == expected, (
        f"Python CLI diverged from the contract\n"
        f"  python  ={json.dumps(py_json)}\n  expected={json.dumps(expected)}\n"
        f"  stderr:\n{py.stderr}"
    )
    assert bun_json == expected, (
        f"Bun CLI diverged from the contract\n"
        f"  bun     ={json.dumps(bun_json)}\n  expected={json.dumps(expected)}\n"
        f"  stderr:\n{bun.stderr}"
    )
    # Exact reset strings across both runtimes and the contract — the pinned-now
    # design makes any mismatch a real bug, never a today/tomorrow-roll flake.
    assert _reset_times(py_json) == _reset_times(bun_json) == _reset_times(expected)
    assert py.returncode == expected_exit, (
        f"python exit {py.returncode} != {expected_exit}"
    )
    assert bun.returncode == expected_exit, (
        f"bun exit {bun.returncode} != {expected_exit}"
    )


def _make_case(dest: Path, base_name: str, overrides: dict) -> tuple[Path, dict]:
    """Clone a corpus case's transcript into `dest` with case.json overrides.

    Lets the CLI-fork tests reuse a real transcript while varying only the fields
    the corpus doesn't sweep (the auth probe's loggedIn, the mount delay, the
    reaping fork flag). Returns (case_dir, merged_meta)."""
    base = CORPUS_DIR / base_name
    meta = json.loads((base / "case.json").read_text())
    meta.update(overrides)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "case.json").write_text(json.dumps(meta))
    shutil.copy(base / "transcript.ansi", dest / "transcript.ansi")
    return dest, meta


# ---------- corpus parity ---------------------------------------------------

_CORPUS = iter_corpus_cases()


@pytest.mark.parametrize(
    "meta, case_dir",
    [pytest.param(meta, cd, id=name) for name, meta, cd in _CORPUS],
)
def test_dual_run_matches_contract_for_corpus(meta: dict, case_dir: Path) -> None:
    gate_bun_and_tmux()
    expected = json.loads((case_dir / "expected.json").read_text())
    py, bun = run_both_clis(
        meta["argv"], case_dir=case_dir, now=meta["now"], tz=meta["tz"]
    )
    _assert_contract_parity(
        py, bun, expected=expected, expected_exit=meta["expected_exit_code"]
    )


# ---------- auth-probe fork -------------------------------------------------

_OK_NO_SUB = {"schema_version": 1, "status": "ok", "no_subscription": True}
_OK_SIGNED_OUT = {"schema_version": 1, "status": "ok", "signed_out": True}

# A no-bar /usage screen (the no-subscription breakdown) makes the CLI run its
# `claude auth status` probe: a definitive logged-out answer becomes signed_out,
# anything else (logged-in OR an inconclusive/garbage probe) stays no_subscription.
_AUTH_FORKS = [
    pytest.param({"logged_in": True}, _OK_NO_SUB, id="loggedIn-true-no_subscription"),
    pytest.param({"logged_in": False}, _OK_SIGNED_OUT, id="loggedIn-false-signed_out"),
    pytest.param(
        {"auth_status_stdout": '{"loggedIn": "yes"}\n'},
        _OK_NO_SUB,
        id="loggedIn-garbage-no_subscription",
    ),
]


@pytest.mark.parametrize("overrides, expected", _AUTH_FORKS)
def test_dual_run_auth_probe_fork(
    tmp_path: Path, overrides: dict, expected: dict
) -> None:
    gate_bun_and_tmux()
    case_dir, meta = _make_case(tmp_path / "case", "claude-no-subscription", overrides)
    py, bun = run_both_clis(
        meta["argv"], case_dir=case_dir, now=meta["now"], tz=meta["tz"]
    )
    _assert_contract_parity(py, bun, expected=expected, expected_exit=0)


# ---------- mount-delay ready-wait race -------------------------------------


@pytest.mark.parametrize("mount_delay_ms", [0, 1000, 2500])
def test_dual_run_survives_mount_delay(tmp_path: Path, mount_delay_ms: int) -> None:
    """A delayed input-ready mount must not lose the slash: both drivers buffer
    it through the mount and still capture the subscribed panel identically."""
    gate_bun_and_tmux()
    case_dir, meta = _make_case(
        tmp_path / "case", "claude-subscribed", {"mount_delay_ms": mount_delay_ms}
    )
    expected = json.loads(
        (CORPUS_DIR / "claude-subscribed" / "expected.json").read_text()
    )
    py, bun = run_both_clis(
        meta["argv"], case_dir=case_dir, now=meta["now"], tz=meta["tz"]
    )
    _assert_contract_parity(py, bun, expected=expected, expected_exit=0)


# ---------- stubborn-child reaping ------------------------------------------


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _assert_child_reaped(pidfile: Path, label: str) -> None:
    """After the CLI exits, the fake's stubborn child must already be gone."""
    assert pidfile.exists(), f"{label}: the fake never recorded a forked child"
    child_pid = int(pidfile.read_text().strip())
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not _alive(child_pid):
            return
        time.sleep(0.1)
    with contextlib.suppress(ProcessLookupError):
        os.kill(child_pid, signal.SIGKILL)  # don't leak the survivor past the test
    pytest.fail(f"{label} left a stubborn child ({child_pid}) alive after cleanup")


@pytest.mark.parametrize(
    "cli, label",
    [
        pytest.param(PY_CLI, "python", id="python"),
        pytest.param(BUN_CLI, "bun", id="bun"),
    ],
)
def test_dual_run_reaps_stubborn_child(tmp_path: Path, cli: list, label: str) -> None:
    """The fake forks a stubborn grandchild in its process group; each CLI's
    cleanup must sweep it, leaving no survivor."""
    gate_bun_and_tmux()
    case_dir, meta = _make_case(
        tmp_path / f"case-{label}", "claude-subscribed", {"fork_child": True}
    )
    pidfile = tmp_path / f"child-{label}.pid"
    home = tmp_path / f"home-{label}"
    home.mkdir()
    proc = run_scrape_cli(
        cli,
        meta["argv"],
        case_dir=case_dir,
        now=meta["now"],
        tz=meta["tz"],
        home=home,
        extra_env={"AGENTUSAGE_FAKE_REAP_PIDFILE": str(pidfile)},
    )
    # The scrape itself must still succeed (subscribed ok arm) — reaping is about
    # cleanup, not a degraded read.
    payload = parse_one_json_line(proc.stdout)
    assert payload["status"] == "ok", f"{label} stderr:\n{proc.stderr}"
    assert proc.returncode == 0
    _assert_child_reaped(pidfile, label)


# ---------- live real-binary parity (opt-in) --------------------------------


@pytest.mark.live
def test_live_real_claude_parity() -> None:
    """One real claude scrape through BOTH CLIs must agree (opt-in: -m live).

    Uses the real binary (no fake), the real HOME (real auth), and a pinned
    AGENTUSAGE_NOW so reset resolution is deterministic across the two separate
    scrapes. Asserts the discriminant + reset strings match; per-window percent
    can jitter between two live reads, so it is not compared."""
    gate_bun_and_tmux()
    sys.path.insert(0, str(REPO_ROOT))
    from scrape import TARGETS

    raw_command = TARGETS["claude"]["command"]
    command = raw_command if isinstance(raw_command, str) else "claude"
    if not (os.path.isfile(command) and os.access(command, os.X_OK)):
        pytest.skip(f"real claude binary not present at {command}")

    now = "2026-05-29T12:00:00-04:00"
    argv = ["--target", "claude", "--profile", "default"]
    env = os.environ.copy()
    env["AGENTUSAGE_NOW"] = now
    env["TZ"] = "America/New_York"

    def _run(cli: list) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [*cli, *argv],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            env=env,
            timeout=90,
            check=False,
        )

    py, bun = _run(PY_CLI), _run(BUN_CLI)
    py_json = parse_one_json_line(py.stdout)
    bun_json = parse_one_json_line(bun.stdout)

    assert py.returncode == bun.returncode, (
        f"exit codes differ: py={py.returncode} bun={bun.returncode}\n"
        f"py stderr:\n{py.stderr}\nbun stderr:\n{bun.stderr}"
    )
    assert py_json["status"] == bun_json["status"]
    # Same discriminant arm (usage keys / no_subscription / signed_out).
    assert set(py_json.get("usage", {})) == set(bun_json.get("usage", {}))
    assert py_json.get("no_subscription") == bun_json.get("no_subscription")
    assert py_json.get("signed_out") == bun_json.get("signed_out")
    # Reset instants are deterministic under the pinned now — they must match.
    assert _reset_times(py_json) == _reset_times(bun_json)
