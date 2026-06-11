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


_UNSET = object()


def _write_envelope(
    state_dir: Path,
    name: str,
    *,
    subscription_active: object,
    target: str = "claude",
    status: str = "active",
    lift_at: object = None,
    multiplier: object = _UNSET,
    session_percent: object = _UNSET,
    usage: object = _UNSET,
) -> None:
    """Write a per-account envelope.

    ``multiplier`` and ``session_percent`` are the balancer inputs. By default
    the envelope carries no ``multiplier`` (the balancer coerces absence to 1)
    and a null ``usage`` (absence → full headroom). Pass ``session_percent`` to
    nest it as ``usage.session.percent_used`` exactly as the producer writes it;
    pass ``usage`` directly to inject a malformed shape for defensive tests.
    """
    if usage is _UNSET:
        usage = (
            None
            if session_percent is _UNSET
            else {"session": {"percent_used": session_percent}}
        )
    envelope: dict[str, object] = {
        "schema_version": 1,
        "id": name,
        "target": target,
        "subscription_active": subscription_active,
        "status": status,
        "usage": usage,
        "lift_at": lift_at,
    }
    if multiplier is not _UNSET:
        envelope["multiplier"] = multiplier
    (state_dir / f"{name}.json").write_text(json.dumps(envelope))


def _counts(state_dir: Path) -> dict[str, int]:
    state = json.loads((state_dir / "picker.json").read_text())
    return {name: entry["count"] for name, entry in state["picks"].items()}


class _MonotonicClock:
    """Fake for ``picker.datetime`` so successive picks get strictly increasing
    stamps — removes any chance of a microsecond tie reordering the rotation."""

    _counter = 0

    @classmethod
    def now(cls) -> _dt.datetime:
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


# ---------- weighted balancing ----------------------------------------------


def test_5x_picked_five_times_as_often_at_equal_headroom(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """At equal (full) headroom, a 5x profile draws ~5x the picks of a 1x over
    a large N — proportionality is the core balancing property."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["pro", "max5"])
    _write_envelope(state_dir, "pro", subscription_active=True, multiplier=1)
    _write_envelope(state_dir, "max5", subscription_active=True, multiplier=5)

    for _ in range(600):
        picker.pick_profile()

    counts = _counts(state_dir)
    ratio = counts["max5"] / counts["pro"]
    assert 4.5 <= ratio <= 5.5, counts


def test_headroom_scales_multiplier_to_even_split(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 10x at 50% session used (effective 5.0) balances evenly against a 5x
    at 0% used (effective 5.0) — headroom scales the multiplier."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["a", "b"])
    _write_envelope(
        state_dir, "a", subscription_active=True, multiplier=10, session_percent=50.0
    )
    _write_envelope(
        state_dir, "b", subscription_active=True, multiplier=5, session_percent=0.0
    )

    for _ in range(400):
        picker.pick_profile()

    counts = _counts(state_dir)
    assert abs(counts["a"] - counts["b"]) <= 1, counts


def test_equal_weights_degrade_to_round_robin(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three profiles at identical weight reproduce round-robin: the first three
    picks are all-distinct and six picks land two each."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["p1", "p2", "p3"])
    for name in ("p1", "p2", "p3"):
        _write_envelope(state_dir, name, subscription_active=True, multiplier=5)

    picks = [picker.pick_profile() for _ in range(6)]

    assert set(picks[:3]) == {"p1", "p2", "p3"}
    assert _counts(state_dir) == {"p1": 2, "p2": 2, "p3": 2}


def test_all_sessions_burned_falls_back_to_multiplier_credit(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every profile at 100% session used (weight floors to 0) → picks still
    distribute by multiplier-only credit and never raise."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["pro", "max5"])
    _write_envelope(
        state_dir, "pro", subscription_active=True, multiplier=1, session_percent=100.0
    )
    _write_envelope(
        state_dir, "max5", subscription_active=True, multiplier=5, session_percent=100.0
    )

    for _ in range(600):
        picker.pick_profile()

    counts = _counts(state_dir)
    assert sum(counts.values()) == 600
    ratio = counts["max5"] / counts["pro"]
    assert 4.5 <= ratio <= 5.5, counts


def test_missing_usage_means_full_headroom(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Missing usage / missing session / missing percent_used all yield full
    headroom (1.0), so two equal-multiplier profiles split evenly."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["nousage", "nosession", "nopercent", "full"])
    _write_envelope(state_dir, "nousage", subscription_active=True, usage=None)
    _write_envelope(state_dir, "nosession", subscription_active=True, usage={})
    _write_envelope(
        state_dir, "nopercent", subscription_active=True, usage={"session": {}}
    )
    _write_envelope(state_dir, "full", subscription_active=True, session_percent=0.0)

    for _ in range(400):
        picker.pick_profile()

    counts = _counts(state_dir)
    assert max(counts.values()) - min(counts.values()) <= 1, counts


def test_new_entrant_gets_no_catch_up_burst(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A profile with no ledger entry enters at min(existing counts), not 0, so
    it doesn't draw a run of consecutive catch-up picks on first appearance."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    # Seed an established ledger: p1 and p2 already have substantial counts.
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "picker.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "picks": {
                    "p1": {"count": 50, "last_picked_at": "2026-01-01T00:00:00"},
                    "p2": {"count": 50, "last_picked_at": "2026-01-01T00:00:00"},
                },
            }
        )
    )
    _write_config(["p1", "p2", "fresh"])
    for name in ("p1", "p2", "fresh"):
        _write_envelope(state_dir, name, subscription_active=True, multiplier=1)

    # The fresh profile enters crediting at min(50, 50) = 50, tying p1/p2.
    # Its first pick is therefore a single pick, not a burst back to parity.
    first = picker.pick_profile()
    assert first == "fresh"  # name tie-break among the three equal credits
    second = picker.pick_profile()
    assert second != "fresh"  # no catch-up burst — fresh already has credit 51


def test_percent_used_over_100_clamps_to_zero_headroom(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A corrupt percent_used > 100 clamps headroom to 0 (weight floors to 0),
    so the over-100 profile only wins via the all-zero multiplier fallback."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["bad", "good"])
    _write_envelope(
        state_dir, "bad", subscription_active=True, multiplier=20, session_percent=150.0
    )
    _write_envelope(
        state_dir, "good", subscription_active=True, multiplier=1, session_percent=0.0
    )

    for _ in range(50):
        picker.pick_profile()

    counts = _counts(state_dir)
    # "bad" has zero headroom while "good" has positive weight, so "good" wins
    # every pick — the over-100 clamp keeps the burned profile out.
    assert counts.get("bad", 0) == 0, counts
    assert counts["good"] == 50


@pytest.mark.parametrize("bad_multiplier", [0, -5, "garbage", 3.5, True, None])
def test_garbage_multiplier_treated_as_one(
    state_dir: Path, monkeypatch: pytest.MonkeyPatch, bad_multiplier: object
) -> None:
    """A multiplier that's 0, negative, non-int, or garbage is coerced to 1, so
    it balances evenly against a genuine 1x profile."""
    monkeypatch.setattr(picker, "datetime", _MonotonicClock)
    _MonotonicClock._counter = 0
    _write_config(["weird", "one"])
    _write_envelope(
        state_dir, "weird", subscription_active=True, multiplier=bad_multiplier
    )
    _write_envelope(state_dir, "one", subscription_active=True, multiplier=1)

    for _ in range(200):
        picker.pick_profile()

    counts = _counts(state_dir)
    assert abs(counts["weird"] - counts["one"]) <= 1, counts


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
    _ = state_dir
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


# ---------- rate-limit cooldown (lift_at) -----------------------------------


def _iso_offset(seconds: int) -> str:
    """ISO stamp offset from `datetime.now().astimezone()` by `seconds`."""
    return (
        _dt.datetime.now().astimezone() + _dt.timedelta(seconds=seconds)
    ).isoformat()


def test_future_lift_at_excludes_profile(state_dir: Path) -> None:
    """A subscribed profile whose `lift_at` is in the future is held out of
    rotation; only the unblocked profile gets picked.

    Doesn't monkeypatch `picker.datetime` — the cooldown filter reads the
    real wall clock to compare against `lift_at`, and the offsets below
    are computed off the same real `now()` so the relation is stable
    regardless of when the suite runs.
    """
    _write_config(["cool", "hot"])
    _write_envelope(state_dir, "cool", subscription_active=True)
    _write_envelope(
        state_dir,
        "hot",
        subscription_active=True,
        lift_at=_iso_offset(3600),  # +1h
    )

    picks = {picker.pick_profile() for _ in range(5)}

    assert picks == {"cool"}
    assert _counts(state_dir) == {"cool": 5}


def test_past_lift_at_does_not_exclude_profile(state_dir: Path) -> None:
    """Once `lift_at` is in the past, the profile rotates again — a stale
    cooldown stamp must not strand a subscribed profile forever."""
    _write_config(["p1", "p2"])
    _write_envelope(
        state_dir, "p1", subscription_active=True, lift_at=_iso_offset(-3600)
    )
    _write_envelope(state_dir, "p2", subscription_active=True)

    picks = {picker.pick_profile() for _ in range(4)}

    assert picks == {"p1", "p2"}


def test_all_rate_limited_falls_back_to_subscribed_set(state_dir: Path) -> None:
    """Fail-open: when every subscribed profile is in cooldown, the picker
    falls back to handing one out anyway rather than collapsing to
    DEFAULT_PROFILE. The wrapper sees the bounce; better that than every
    launch silently routing past the configured catalog."""
    _write_config(["p1", "p2"])
    _write_envelope(
        state_dir, "p1", subscription_active=True, lift_at=_iso_offset(3600)
    )
    _write_envelope(
        state_dir, "p2", subscription_active=True, lift_at=_iso_offset(7200)
    )

    picks = [picker.pick_profile() for _ in range(4)]

    assert all(p in {"p1", "p2"} for p in picks)
    counts = _counts(state_dir)
    assert sum(counts.values()) == 4


def test_malformed_lift_at_is_ignored(state_dir: Path) -> None:
    """A garbage `lift_at` value (non-string / unparseable / naive) must not
    block selection — treat as "no cooldown" rather than as "rate-limited
    forever"."""
    _write_config(["garbage", "naive", "good"])
    _write_envelope(
        state_dir, "garbage", subscription_active=True, lift_at="not-a-date"
    )
    # Naive ISO (no tz offset) — corrupted envelope, must not block selection.
    _write_envelope(
        state_dir, "naive", subscription_active=True, lift_at="2099-01-01T00:00:00"
    )
    _write_envelope(state_dir, "good", subscription_active=True)

    picks = {picker.pick_profile() for _ in range(6)}

    assert picks == {"garbage", "naive", "good"}


# ---------- list_profiles ---------------------------------------------------


def test_list_profiles_reads_catalog(state_dir: Path) -> None:
    _ = state_dir
    _write_config(["alpha", "beta"])
    assert picker.list_profiles() == ["alpha", "beta"]


def test_list_profiles_fail_open_empty(state_dir: Path) -> None:
    """Missing config → empty list, never raises."""
    _ = state_dir
    assert picker.list_profiles() == []
