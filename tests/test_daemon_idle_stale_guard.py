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
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# Repo lays flat (no `src/`); make the modules importable without an editable
# install. Mirrors the sibling test file's pattern.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import daemon  # noqa: E402

# Wall-clock ceiling for waiting on the loop's first state-file write. The
# write lands in ~1-5ms once the cycle reaches its `write_atomic` call; this
# is the loud-failure backstop, not the expected latency.
_WRITE_TIMEOUT_S = 2.0


def _install_write_event(monkeypatch: pytest.MonkeyPatch) -> asyncio.Event:
    """Wrap `daemon.write_atomic` so the test can await the cycle's first write.

    The loop writes its envelope via `write_atomic` and then parks in a long
    trailing `await asyncio.sleep(...)`, yielding control. The seed is written
    via `state_path.write_text` (not `write_atomic`), so the event fires exactly
    on the cycle's write — immune to the seed-equals-terminal-status case and
    uniform across all five tests.
    """
    written = asyncio.Event()
    real_write_atomic = daemon.write_atomic

    def _wrapped(*args, **kwargs):
        real_write_atomic(*args, **kwargs)
        written.set()

    monkeypatch.setattr(daemon, "write_atomic", _wrapped)
    return written


async def _run_until_first_write(acct: daemon.Account, written: asyncio.Event) -> None:
    """Run `account_loop` until its first state-file write, then cancel.

    Replaces the old fixed `await asyncio.sleep(0.5)` gate: we wait on the
    observable write (with a loud timeout) and cancel while the loop is parked
    in its trailing sleep, instead of guessing at a settle time.
    """
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
        try:
            await asyncio.wait_for(written.wait(), timeout=_WRITE_TIMEOUT_S)
        except asyncio.TimeoutError:
            task.cancel()
            pytest.fail(
                "account_loop never wrote its envelope within "
                f"{_WRITE_TIMEOUT_S}s — the cycle did not reach write_atomic"
            )
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


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
    asyncio.run(_run_stale_guard(tmp_path, monkeypatch))


def test_idle_skip_preserves_lift_at(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prior envelope is `active` with a future `lift_at`; idle window is
    exceeded so the idle-skip branch fires. The on-disk envelope must flip to
    `status: "idle"` AND carry the prior `lift_at` forward unchanged — if
    the idle write dropped it, a paused rate-limited profile would lose its
    cooldown visibility mid-window.

    Driven via `asyncio.run` for the same reason as the sibling test.
    """
    asyncio.run(_run_idle_lift(tmp_path, monkeypatch))


def test_stale_writeback_preserves_lift_at(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prior envelope is `active` with a future `lift_at`; the scrape fails
    so the loop takes the stale writeback branch. The on-disk envelope must
    flip to `status: "stale"` AND carry the prior `lift_at` forward — same
    rationale as the idle case: a transient scrape failure must not lose a
    still-valid cooldown.
    """
    asyncio.run(_run_stale_lift(tmp_path, monkeypatch))


def test_rate_limit_cooldown_pauses_scrape_until_lift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prior envelope is `active` with a future `lift_at`; the loop must
    take the cooldown branch instead of scraping. The scrape stub asserts
    we never reach it; the on-disk envelope must carry `lift_at` forward
    and schedule `next_fetch_at >= lift_at` so the resume is guaranteed."""
    asyncio.run(_run_rate_limit_pause(tmp_path, monkeypatch))


def test_stale_prior_with_future_lift_at_still_scrapes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cooldown branch must NOT engage when the prior envelope is
    `stale` — a failing account needs to keep retrying even while its
    last-known `lift_at` is in the future, otherwise a stale envelope
    with a stale future-cooldown would never refresh. The scrape stub
    raises so the cycle takes the stale-writeback branch and we assert
    the envelope stays `stale` (proving the cooldown branch was bypassed)."""
    asyncio.run(_run_stale_prior_cooldown_bypass(tmp_path, monkeypatch))


async def _run_rate_limit_pause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct, state_path = _seed_state_dir(tmp_path, monkeypatch)

    # Pin lift_at one hour in the (real) future so the cooldown branch
    # decides "still rate-limited". The branch reads wall-clock now()
    # directly — no monkeypatch on daemon.datetime — so the comparison
    # is against actual time, and we never await the full pause (the
    # test cancels the task after the cooldown write).
    lift_at_dt = datetime.now().astimezone() + timedelta(hours=1)
    lift_at_iso = lift_at_dt.isoformat()
    prior = {
        "schema_version": daemon.ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": "active",
        "subscription_active": True,
        "last_successful_fetch_at": "2026-05-29T11:00:00-04:00",
        "last_skipped_fetch_at": None,
        "last_failed_fetch_at": None,
        "next_fetch_at": "2026-05-29T12:00:00-04:00",
        "usage": {
            "session": {"percent_used": 100.0, "resets_at": lift_at_iso},
        },
        "lift_at": lift_at_iso,
        "error": None,
    }
    state_path.write_text(json.dumps(prior) + "\n")

    # Keep us out of the idle branch — the cooldown branch should fire
    # first regardless, but pinning recent activity isolates the assertion
    # to the cooldown path.
    monkeypatch.setattr(daemon, "_latest_agent_activity", lambda: time.time())
    monkeypatch.setattr(daemon, "_initial_delay", lambda *_: 0.0)

    # If the cooldown branch failed to engage, the loop would invoke
    # scrape — which we assert can't happen by raising here. The stale
    # writeback would then overwrite `status: "stale"` and fail the
    # status assertion below, but the explicit AssertionError makes the
    # failure mode obvious in the log.
    def _must_not_scrape(*_):
        raise AssertionError(
            "scrape invoked while rate-limited; cooldown branch did not engage"
        )

    monkeypatch.setattr(daemon, "scrape", _must_not_scrape)

    await _drive_one_cycle(acct, monkeypatch)

    written = json.loads(state_path.read_text())
    assert written["status"] == "idle", (
        f"cooldown branch should have written `idle`, got {written['status']!r}"
    )
    assert written["lift_at"] == lift_at_iso, (
        f"cooldown write dropped lift_at: {written.get('lift_at')!r}"
    )
    # Resume guarantee: the next scrape is scheduled at-or-after the
    # lift, so the loop will actually wake up and try again once the
    # limit releases.
    next_fetch = datetime.fromisoformat(written["next_fetch_at"])
    assert next_fetch >= lift_at_dt, (
        f"next_fetch_at {next_fetch.isoformat()} must be >= lift_at "
        f"{lift_at_dt.isoformat()} so cooldown doesn't pause forever"
    )
    # Usage payload rides forward unchanged (visibility doesn't flicker).
    assert written["usage"] == prior["usage"]


async def _run_stale_prior_cooldown_bypass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct, state_path = _seed_state_dir(tmp_path, monkeypatch)

    lift_at_dt = datetime.now().astimezone() + timedelta(hours=1)
    lift_at_iso = lift_at_dt.isoformat()
    # `status: "stale"` with a future `lift_at` — the stale gate at the
    # top of the idle/cooldown block must shunt past BOTH so the loop
    # actually scrapes. We stub scrape to raise, sending it down the
    # stale-writeback branch.
    prior = {
        "schema_version": daemon.ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": "stale",
        "subscription_active": True,
        "last_successful_fetch_at": "2026-05-29T11:00:00-04:00",
        "last_skipped_fetch_at": None,
        "last_failed_fetch_at": "2026-05-29T11:30:00-04:00",
        "next_fetch_at": "2026-05-29T12:00:00-04:00",
        "usage": {
            "session": {"percent_used": 100.0, "resets_at": lift_at_iso},
        },
        "lift_at": lift_at_iso,
        "error": {"type": "RuntimeError", "message": "x", "at": "y"},
    }
    state_path.write_text(json.dumps(prior) + "\n")

    monkeypatch.setattr(daemon, "_latest_agent_activity", lambda: time.time())
    monkeypatch.setattr(daemon, "_initial_delay", lambda *_: 0.0)

    scrape_calls = {"count": 0}

    def _boom(*_):
        scrape_calls["count"] += 1
        raise RuntimeError("scrape stubbed; cooldown bypass proves we got here")

    monkeypatch.setattr(daemon, "scrape", _boom)

    await _drive_one_cycle(acct, monkeypatch)

    written = json.loads(state_path.read_text())
    # The loop reached scrape (cooldown was bypassed) and the failure
    # took the stale-writeback branch.
    assert scrape_calls["count"] >= 1, (
        "scrape was not invoked; cooldown branch incorrectly fired on stale prior"
    )
    assert written["status"] == "stale", (
        f"expected stale writeback, got {written['status']!r}"
    )


async def _run_stale_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
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
    monkeypatch.setattr(daemon, "_initial_delay", lambda *_: 0.0)

    # Stub the live scrape so that if the guard ever lets execution past it
    # (the bug we're guarding against the inverse of), we don't actually spawn
    # a claude TUI — we raise so the except branch writes back `stale` again
    # via `_build_envelope(status="stale", ...)`. Either way the on-disk
    # envelope must stay `stale`; flipping to `idle` is the regression.
    def _boom(*_):
        raise RuntimeError("scrape stubbed in test")

    monkeypatch.setattr(daemon, "scrape", _boom)

    # Run the loop until it writes its envelope (the stale except-branch
    # writeback), then cancel — no fixed sleep gate.
    written = _install_write_event(monkeypatch)
    await _run_until_first_write(acct, written)

    # The envelope must still report `stale`. If the guard were inverted (or
    # removed), the idle-skip branch would have written `status: "idle"` here.
    written = json.loads(state_path.read_text())
    assert written["status"] == "stale", (
        f"stale envelope was clobbered to {written['status']!r}; "
        "the daemon.py:500 stale-guard regressed"
    )


# Lift-time preservation tests below share state-dir setup + the cycle
# driver with the stale-guard test. Kept as inline helpers rather than
# fixtures because pytest-asyncio isn't a dev-dep here and each test
# needs its own monkeypatched daemon attrs anyway.


def _seed_state_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[daemon.Account, Path]:
    """Redirect STATE_DIR/EVENTS_LOG into tmp + return account + state path."""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    monkeypatch.setattr(daemon, "STATE_DIR", state_dir)
    monkeypatch.setattr(daemon, "EVENTS_LOG", state_dir / "events.jsonl")
    acct: daemon.Account = {
        "id": "test-lift-preserve",
        "target": "claude",
        "passthrough": [],
        "multiplier": 1,
    }
    return acct, state_dir / f"{acct['id']}.json"


async def _drive_one_cycle(
    acct: daemon.Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run account_loop until its first state-file write, then cancel.

    Waits on the observable `write_atomic` (via an event wrapper) with a loud
    timeout instead of a fixed sleep gate.
    """
    written = _install_write_event(monkeypatch)
    await _run_until_first_write(acct, written)


async def _run_idle_lift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    acct, state_path = _seed_state_dir(tmp_path, monkeypatch)

    # Prior is `active` (NOT stale — so the idle-skip branch is allowed to
    # fire) with a future lift_at. The idle write must carry lift_at forward.
    lift_at_iso = "2026-06-15T09:00:00-04:00"
    prior = {
        "schema_version": daemon.ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": "active",
        "subscription_active": True,
        "last_successful_fetch_at": "2026-05-29T11:00:00-04:00",
        "last_skipped_fetch_at": None,
        "last_failed_fetch_at": None,
        "next_fetch_at": "2026-05-29T12:00:00-04:00",
        "usage": {
            "session": {"percent_used": 100.0, "resets_at": lift_at_iso},
            "week": {"percent_used": 50.0, "resets_at": "2026-07-01T09:00:00-04:00"},
        },
        "lift_at": lift_at_iso,
        "error": None,
    }
    state_path.write_text(json.dumps(prior) + "\n")

    # Force the idle window: no agent activity for well over the threshold.
    monkeypatch.setattr(
        daemon,
        "_latest_agent_activity",
        lambda: time.time() - daemon.IDLE_THRESHOLD_S - 600,
    )
    monkeypatch.setattr(daemon, "_initial_delay", lambda *_: 0.0)
    # Stub scrape so that if the idle branch ever didn't fire we wouldn't
    # spawn a real TUI; the test asserts on the idle write so we shouldn't
    # reach it either way.
    monkeypatch.setattr(
        daemon,
        "scrape",
        lambda *_: (_ for _ in ()).throw(RuntimeError("nope")),
    )

    await _drive_one_cycle(acct, monkeypatch)

    written = json.loads(state_path.read_text())
    assert written["status"] == "idle", (
        f"expected idle-skip to fire from active prior, got {written['status']!r}"
    )
    assert written["lift_at"] == lift_at_iso, (
        f"idle write dropped lift_at: {written.get('lift_at')!r} != {lift_at_iso!r}"
    )


async def _run_stale_lift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    acct, state_path = _seed_state_dir(tmp_path, monkeypatch)

    # Pin lift_at in the PAST so the rate-limit cooldown branch (added in
    # fn-651.3) doesn't fire and intercept before we reach scrape. The
    # preservation contract under test is the stale-writeback branch's,
    # not the cooldown branch's — see _run_rate_limit_pause for that.
    lift_at_iso = (datetime.now().astimezone() - timedelta(hours=1)).isoformat()
    prior = {
        "schema_version": daemon.ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": "active",
        "subscription_active": True,
        "last_successful_fetch_at": "2026-05-29T11:00:00-04:00",
        "last_skipped_fetch_at": None,
        "last_failed_fetch_at": None,
        "next_fetch_at": "2026-05-29T12:00:00-04:00",
        "usage": {
            "session": {"percent_used": 100.0, "resets_at": lift_at_iso},
        },
        "lift_at": lift_at_iso,
        "error": None,
    }
    state_path.write_text(json.dumps(prior) + "\n")

    # Keep us out of the idle branch: claim recent activity so the loop
    # proceeds to scrape — which we stub to raise, sending it down the
    # stale-writeback path where the preservation contract applies.
    monkeypatch.setattr(daemon, "_latest_agent_activity", lambda: time.time())
    monkeypatch.setattr(daemon, "_initial_delay", lambda *_: 0.0)

    def _boom(*_):
        raise RuntimeError("scrape stubbed in test")

    monkeypatch.setattr(daemon, "scrape", _boom)

    await _drive_one_cycle(acct, monkeypatch)

    written = json.loads(state_path.read_text())
    assert written["status"] == "stale", (
        f"expected stale writeback from failed scrape, got {written['status']!r}"
    )
    assert written["lift_at"] == lift_at_iso, (
        f"stale write dropped lift_at: {written.get('lift_at')!r} != {lift_at_iso!r}"
    )
