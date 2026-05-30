"""Behavior pins for the dumb round-robin picker (`agentuse.api`).

Covers the four things beat-1 promised: rotation across subscribed accounts,
empty-set → ``"default"``, the no-subscription / missing-envelope skips, and
the flock serializing concurrent picks so the rotation can't be raced into an
uneven draw.

The picker reads two sources we redirect into tmp: the per-account envelopes
under ``STATE_DIR`` (monkeypatched on the module) and the catalog at
``$XDG_CONFIG_HOME/agentuse/config.yaml`` (redirected via the env var, which
``picker._config_path`` honors at call time).
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import yaml

# The ``as picker`` alias keeps every monkeypatch.setattr(picker, ...) call
# below working unchanged after the picker module became ``agentuse.api``.
import agentuse.api as picker


# ---------- fixtures / helpers ----------------------------------------------


@pytest.fixture
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect picker STATE_DIR + the agentuse config home into tmp."""
    sd = tmp_path / "state"
    sd.mkdir()
    monkeypatch.setattr(picker, "STATE_DIR", sd)

    cfg_home = tmp_path / "config"
    (cfg_home / "agentuse").mkdir(parents=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_home))
    return sd


def _write_config(profiles: list[str]) -> None:
    cfg = Path(os.environ["XDG_CONFIG_HOME"]) / "agentuse" / "config.yaml"
    cfg.write_text(yaml.safe_dump({"profiles": profiles}))


def _write_envelope(
    state_dir: Path,
    name: str,
    *,
    subscription_active: object,
    target: str = "claude",
    status: str = "active",
) -> None:
    (state_dir / f"{name}.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "id": name,
                "target": target,
                "subscription_active": subscription_active,
                "status": status,
                "usage": None,
            }
        )
    )


def _counts(state_dir: Path) -> dict[str, int]:
    state = json.loads((state_dir / "picker.json").read_text())
    return {name: entry["count"] for name, entry in state["picks"].items()}


class _MonotonicClock:
    """Fake for ``picker.datetime`` so successive picks get strictly increasing
    stamps — removes any chance of a microsecond tie reordering the rotation."""

    _counter = 0

    @classmethod
    def now(cls, _tz: object = None) -> _dt.datetime:
        cls._counter += 1
        return _dt.datetime(2026, 1, 1) + _dt.timedelta(seconds=cls._counter)

    @staticmethod
    def fromisoformat(value: str) -> _dt.datetime:
        return _dt.datetime.fromisoformat(value)


# ---------- rotation --------------------------------------------------------


def test_pick_rotates_round_robin(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three subscribed accounts: six picks visit each exactly twice, and the
    first three are all-distinct (a full cycle before any repeat)."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["p1", "p2", "p3"])
    for name in ("p1", "p2", "p3"):
        _write_envelope(state_dir, name, subscription_active=True)

    picks = [picker.pick_profile() for _ in range(6)]

    assert set(picks[:3]) == {"p1", "p2", "p3"}  # full cycle, no early repeat
    assert _counts(state_dir) == {"p1": 2, "p2": 2, "p3": 2}


def test_stale_account_still_rotates(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No stale filter in v1: a stale-but-subscribed account stays eligible."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["p1", "p2"])
    _write_envelope(state_dir, "p1", subscription_active=True, status="active")
    _write_envelope(state_dir, "p2", subscription_active=True, status="stale")

    picks = {picker.pick_profile() for _ in range(4)}

    assert picks == {"p1", "p2"}


# ---------- empty / skip paths ----------------------------------------------


def test_no_eligible_returns_default_without_writing_state(state_dir: Path) -> None:
    """Configured but nothing subscribed → "default", and no picker.json is
    created (the empty-set check returns before the lock/RMW)."""
    _write_config(["p1", "p2"])
    _write_envelope(state_dir, "p1", subscription_active=False)
    # p2 has no envelope at all (daemon hasn't scraped it yet).

    assert picker.pick_profile() == "default"
    assert not (state_dir / "picker.json").exists()


def test_no_config_returns_default(state_dir: Path) -> None:
    """No catalog at all → no eligible profiles → "default"."""
    assert picker.pick_profile() == "default"


def test_unsubscribed_and_missing_and_codex_are_skipped(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only the subscribed claude account is ever picked; a sub=False account,
    a missing envelope, and a non-claude target are all excluded."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["sub", "nosub", "missing", "weird"])
    _write_envelope(state_dir, "sub", subscription_active=True)
    _write_envelope(state_dir, "nosub", subscription_active=False)
    # "missing": no envelope written.
    _write_envelope(state_dir, "weird", subscription_active=True, target="codex")

    picks = {picker.pick_profile() for _ in range(5)}

    assert picks == {"sub"}
    assert _counts(state_dir) == {"sub": 5}


# ---------- fail-open -------------------------------------------------------


def test_corrupt_picker_state_is_reset_not_fatal(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A garbage picker.json is treated as absent — the pick still succeeds and
    rewrites valid state rather than raising."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["p1"])
    _write_envelope(state_dir, "p1", subscription_active=True)
    (state_dir / "picker.json").write_text("{ not json at all ]")

    assert picker.pick_profile() == "p1"
    assert _counts(state_dir) == {"p1": 1}


def test_pick_never_raises_on_unreadable_state_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If STATE_DIR can't be created (a file sits where the dir should be), the
    fail-open wrapper still returns "default" rather than propagating."""
    blocker = tmp_path / "state"
    blocker.write_text("i am a file, not a dir")
    monkeypatch.setattr(picker, "STATE_DIR", blocker)
    cfg_home = tmp_path / "config"
    (cfg_home / "agentuse").mkdir(parents=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_home))
    _write_config(["p1"])
    # No envelope readable under a non-dir STATE_DIR → eligible is empty anyway,
    # but the point is the call returns a string and does not raise.
    assert picker.pick_profile() == "default"


# ---------- concurrency (the flock) -----------------------------------------


def test_concurrent_picks_distribute_evenly(state_dir: Path) -> None:
    """The flock serializes the read-modify-write: 30 concurrent picks across 3
    eligible accounts land exactly 30 recorded picks, balanced to within one.

    Without the lock, racing read-modify-writes would lose updates (sum < 30)
    and/or skew the distribution. This is the regression that proves the lock.
    """
    _write_config(["p1", "p2", "p3"])
    for name in ("p1", "p2", "p3"):
        _write_envelope(state_dir, name, subscription_active=True)

    n = 30
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: picker.pick_profile(), range(n)))

    assert all(r in {"p1", "p2", "p3"} for r in results)
    counts = _counts(state_dir)
    assert sum(counts.values()) == n  # no lost updates
    assert max(counts.values()) - min(counts.values()) <= 1  # balanced


# ---------- list_profiles ---------------------------------------------------


def test_list_profiles_reads_catalog(state_dir: Path) -> None:
    _write_config(["alpha", "beta"])
    assert picker.list_profiles() == ["alpha", "beta"]


def test_list_profiles_fail_open_empty(state_dir: Path) -> None:
    """Missing config → empty list, never raises."""
    assert picker.list_profiles() == []
