"""Regression guard for the stale-status protection in the idle-skip path.

`daemon.account_loop` has a load-bearing branch at the top of each cycle: when
the prior envelope already records `status: "stale"`, the idle-skip block must
NOT run — otherwise a failing account silently flips to `status: "idle"` once
no agent has touched a session log for IDLE_THRESHOLD_S, and a polling client
reads it as good data.

This test pins that branch as-is. We mock the two pure helpers the guard reads
(`_latest_agent_activity` for the idle window, `scrape` so the loop never
reaches a real TUI), seed a stale `<id>.json`, run one cycle of `account_loop`
under a wall-clock deadline, then assert the on-disk envelope still says
`stale`.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install. Mirrors the sibling test file's pattern.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import daemon  # noqa: E402


def test_stale_envelope_preserved_when_idle_skip_would_fire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prior envelope is `stale`; idle window is exceeded. The idle-skip block
    must be gated off so the on-disk status stays `stale` (does not flip to
    `idle`).

    Driven via `asyncio.run` rather than `pytest.mark.asyncio` — this repo's
    dev-deps don't include `pytest-asyncio` and adding it just for one test
    would be heavier than the cycle this test exercises.
    """
    asyncio.run(_run(tmp_path, monkeypatch))


async def _run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Redirect STATE_DIR + EVENTS_LOG into a tmp dir so the test never touches
    # the developer's real ~/.local/state/agentuse.
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    monkeypatch.setattr(daemon, "STATE_DIR", state_dir)
    monkeypatch.setattr(daemon, "EVENTS_LOG", state_dir / "events.jsonl")

    # Pick any registered account; the guard is account-agnostic. Using a real
    # entry keeps the Account TypedDict shape honest.
    # Synthesize a minimal Account rather than depending on the host's config
    # — the registered ACCOUNTS list is environment-specific (empty without
    # ~/.config/agentuse/config.yaml) and the guard doesn't care which target
    # it runs against.
    acct: daemon.Account = {
        "id": "test-stale-guard",
        "target": "claude",
        "passthrough": [],
        "multiplier": 1,
    }
    state_path = state_dir / f"{acct['id']}.json"

    # Seed a stale envelope. Only `status` matters for the guard, but include
    # the full canonical key set so `_load_envelope` returns realistic shape.
    stale_envelope = {
        "schema_version": daemon.ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": "stale",
        "subscription_active": True,
        "last_successful_fetch_at": "2026-05-28T12:00:00-04:00",
        "last_skipped_fetch_at": None,
        "last_failed_fetch_at": "2026-05-29T11:00:00-04:00",
        "next_fetch_at": "2026-05-29T12:00:00-04:00",
        "usage": {"session": {"percent_used": 42.0}},
        "error": {"type": "RuntimeError", "message": "prior failure", "at": "x"},
    }
    state_path.write_text(json.dumps(stale_envelope) + "\n")

    # Force the idle condition: claim no agent has touched a session log for
    # well beyond IDLE_THRESHOLD_S. Without the stale-guard, the loop would
    # take the idle-skip branch and overwrite with `status: "idle"`.
    monkeypatch.setattr(
        daemon,
        "_latest_agent_activity",
        lambda: time.time() - daemon.IDLE_THRESHOLD_S - 600,
    )

    # Skip the boot jitter so the loop hits the guard immediately.
    monkeypatch.setattr(daemon, "_initial_delay", lambda acct, log: 0.0)

    # Stub the live scrape so that if the guard ever lets execution past it
    # (the bug we're guarding against the inverse of), we don't actually spawn
    # a claude TUI — we raise so the except branch writes back `stale` again
    # via `_build_envelope(status="stale", ...)`. Either way the on-disk
    # envelope must stay `stale`; flipping to `idle` is the regression.
    def _boom(*_a, **_kw):
        raise RuntimeError("scrape stubbed in test")

    monkeypatch.setattr(daemon, "scrape", _boom)

    # Run the loop briefly, then cancel. Account loop is an infinite while-True;
    # we just need it to execute one iteration through the guard.
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        task = asyncio.create_task(
            daemon.account_loop(
                acct,
                executor,
                asyncio.Lock(),
                asyncio.Lock(),
                {"next_allowed_at": 0.0},
                asyncio.Lock(),
            )
        )
        # Let the loop body run; 0.5s is generous for one synchronous-ish pass
        # through the guard + the stubbed scrape's RuntimeError + the stale
        # except-branch writeback.
        await asyncio.sleep(0.5)
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    # The envelope must still report `stale`. If the guard were inverted (or
    # removed), the idle-skip branch would have written `status: "idle"` here.
    written = json.loads(state_path.read_text())
    assert written["status"] == "stale", (
        f"stale envelope was clobbered to {written['status']!r}; "
        "the daemon.py:500 stale-guard regressed"
    )
