"""Profile picker — the client-side balancer the README's data contract feeds.

The daemon (`daemon.py`) is the *producer*: it scrapes each account and writes
`~/.local/state/agentuse/<id>.json` envelopes. This module is the first
*consumer* — the dumb balancer an external launcher (arthack's claude wrapper)
calls to answer one question: **"which Claude profile should I use right now?"**

Two public functions, both fail-open and side-effect-light so importing this
module never spins up the daemon's account registry:

- ``pick_profile() -> str`` — credit-weighted balance over subscribed accounts.
- ``list_profiles() -> list[str]`` — the configured Claude profile names.

`pick_profile` is a stride-scheduling balancer (v2):

- **Eligible** = a configured profile whose envelope says ``target == "claude"``
  and ``subscription_active is True``. No subscription (or no envelope yet, or
  unknown) → not eligible. There is **no stale filter**: a ``status == "stale"``
  account still rotates, balancing on its last-good headroom.
- **Weighted balance** = each eligible profile gets an ``effective_weight =
  multiplier × session_headroom``, where ``session_headroom = clamp(1 −
  usage.session.percent_used/100, 0, 1)``. The pick minimizes ``count /
  weight`` (credit-based stride scheduling); name breaks ties for determinism.
  A Max-5x account absorbs ~5× the picks of a Pro account at equal headroom,
  and a profile whose session window fills up sheds load automatically — quota
  burn is the feedback signal. Only the **session** window weighs (v1 scope):
  quota-left beats time-left because quota is the binding constraint. If every
  eligible weight floors to 0 (all sessions burned), the same credit rule re-runs
  on ``multiplier`` alone. Counts are never reset when weights change; a fresh
  profile enters at ``min(existing counts)`` so it gets no catch-up burst.
- **Fail-open** = any failure (no eligible profile, unreadable state, lock
  trouble, corrupt JSON) returns ``"default"``. The function never raises; a
  broken picker must never block a launch. ``"default"`` is itself a real
  account id, so the fallback and a legitimate pick are the same string.

The pick is recorded in ``~/.local/state/agentuse/picker.json`` — the credit
ledger (per-profile ``count``) the balancer reads to compute ``count / weight``.
The read-modify-write is serialized with an `fcntl` lock so two concurrent
launches can't both draw the same profile and defeat the balance.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

# Returned when no profile resolves. Also a real account id — the wrapper maps
# "default" onto the default Claude account.
DEFAULT_PROFILE = "default"

# Bumped when picker.json's shape changes. A file with an unrecognized version
# is treated as absent (start fresh) rather than migrated.
PICKER_SCHEMA_VERSION = 1

# Mirrors daemon.STATE_DIR. Kept as a module global (not derived into the path
# constants below) so tests can monkeypatch it.
STATE_DIR = Path.home() / ".local" / "state" / "agentuse"


def _picker_state_path() -> Path:
    return STATE_DIR / "picker.json"


def _picker_lock_path() -> Path:
    return STATE_DIR / "picker.json.lock"


def _config_path() -> Path:
    """`~/.config/agentuse/config.yaml` — the same catalog the daemon reads."""
    env = os.environ.get("XDG_CONFIG_HOME")
    base = Path(env) if env else Path.home() / ".config"
    return base / "agentuse" / "config.yaml"


# ---------- list_profiles ---------------------------------------------------


def list_profiles() -> list[str]:
    """Configured Claude profile names from agentuse's config.yaml.

    Reads the same ``profiles: [name1, name2, ...]`` list the daemon builds its
    account registry from (codex is appended in code, never in the list, so it
    is naturally excluded here). Fail-open: any missing/malformed config returns
    an empty list rather than raising.
    """
    try:
        with open(_config_path()) as f:
            data = yaml.safe_load(f)
    except (OSError, yaml.YAMLError):
        return []
    if not isinstance(data, dict):
        return []
    raw = data.get("profiles", [])
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, str) and entry]


# ---------- pick_profile ----------------------------------------------------


def pick_profile() -> str:
    """Credit-weighted balance over subscribed accounts; ``"default"`` if none.

    Picks the eligible profile minimizing ``count / (multiplier × session
    headroom)`` — stride scheduling, so a higher-multiplier or
    lower-usage profile is picked proportionally more often. Falls back to
    ``multiplier``-only credit when every session window is fully burned.
    Never raises — every failure path returns ``DEFAULT_PROFILE``.
    """
    try:
        return _pick_profile()
    except Exception:
        return DEFAULT_PROFILE


def _pick_profile() -> str:
    eligible = _eligible_profiles()
    if not eligible:
        # Fail-open: if the rate-limit filter stranded the eligible set,
        # fall back to the subscribed-only set so a launch isn't blocked
        # just because every profile is cooling down. Better to pick a
        # rate-limited profile (the wrapper sees the same error) than to
        # silently route every launch to DEFAULT_PROFILE.
        eligible = _eligible_profiles(include_rate_limited=True)
        if not eligible:
            return DEFAULT_PROFILE

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with _exclusive_lock():
        state = _load_picker_state()
        _seed_new_entrants(state, [name for name, _ in eligible])
        chosen = _choose(eligible, _counts(state))
        _record_pick(state, chosen)
        _write_picker_state(state)
    return chosen


def _is_rate_limited_now(envelope: dict[str, Any], now: datetime) -> bool:
    """True iff the envelope's ``lift_at`` parses as a future instant.

    Pure: no I/O, no clock read — the caller supplies ``now`` so tests can
    pin the comparison instant. Returns False on missing / non-string /
    unparseable / past lift_at; the rate-limit pause is opt-in on a
    well-formed future stamp, never inferred from absence.
    """
    raw = envelope.get("lift_at")
    if not isinstance(raw, str):
        return False
    try:
        lift = datetime.fromisoformat(raw)
    except ValueError:
        return False
    # Compare aware-to-aware. agentuse always writes tz-aware ISO stamps
    # (`now().astimezone().isoformat()`), so a naive `lift` here is a
    # corrupted envelope — treat as not-rate-limited and let normal
    # rotation continue rather than blocking on garbage.
    if lift.tzinfo is None:
        return False
    return lift > now


def _eligible_profiles(
    *, include_rate_limited: bool = False
) -> list[tuple[str, dict[str, Any]]]:
    """Configured profiles confirmed to have an active Claude subscription.

    Returns ``(name, envelope)`` pairs so the caller weighs each profile from
    the same single envelope read used for eligibility.

    A profile qualifies only when its envelope exists and says it is a
    subscribed claude account. Missing envelope (daemon hasn't scraped yet) or
    ``subscription_active`` anything other than ``True`` → excluded. No status
    check — stale accounts still rotate (v1 decision).

    Rate-limit cooldown: by default, profiles whose envelope carries a
    ``lift_at`` in the future are also excluded so the picker stops handing
    out a profile that's certain to bounce. Pass ``include_rate_limited=True``
    to bypass the cooldown filter — used by the fail-open fallback in
    ``_pick_profile`` when every subscribed profile is in cooldown.
    """
    now = datetime.now().astimezone()
    eligible: list[tuple[str, dict[str, Any]]] = []
    for name in list_profiles():
        envelope = _load_envelope(STATE_DIR / f"{name}.json")
        if envelope.get("target") != "claude":
            continue
        if envelope.get("subscription_active") is not True:
            continue
        if not include_rate_limited and _is_rate_limited_now(envelope, now):
            continue
        eligible.append((name, envelope))
    return eligible


def _effective_weight(envelope: dict[str, Any]) -> float:
    """``multiplier × session_headroom`` for one envelope; floored to 0 below 1e-9.

    ``multiplier`` is external input: a non-int or value < 1 is coerced to 1
    (the daemon only writes {1,5,20}). ``session_headroom`` = clamp(1 −
    ``usage.session.percent_used``/100, 0, 1); a missing ``usage``/``session``/
    ``percent_used`` or a non-numeric value means full headroom (1.0). The
    nesting is exactly ``usage["session"]["percent_used"]`` — a flat read would
    silently always yield full headroom and mask a producer bug.
    """
    return _multiplier(envelope) * _session_headroom(envelope)


def _multiplier(envelope: dict[str, Any]) -> int:
    raw = envelope.get("multiplier")
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        return 1
    return raw


def _session_headroom(envelope: dict[str, Any]) -> float:
    usage = envelope.get("usage")
    session = usage.get("session") if isinstance(usage, dict) else None
    percent = session.get("percent_used") if isinstance(session, dict) else None
    if isinstance(percent, bool) or not isinstance(percent, (int, float)):
        return 1.0
    headroom = 1.0 - percent / 100.0
    return min(1.0, max(0.0, headroom))


def _choose(eligible: list[tuple[str, dict[str, Any]]], counts: dict[str, int]) -> str:
    """Eligible profile minimizing ``count / effective_weight``; ties by name.

    Stride scheduling: the profile with the least accrued service per unit of
    weight wins, so a heavier weight draws proportionally more picks. ``counts``
    is the per-profile credit ledger (already carrying the new-entrant seed, so
    a fresh profile reads its pool-minimum baseline here, not 0). Profiles whose
    weight floors to 0 are excluded; if *every* weight is 0 (all session windows
    burned), the rule re-runs on ``multiplier`` alone so a launch still routes by
    capacity rather than collapsing to ``default``.
    """
    weights = [(name, _effective_weight(env)) for name, env in eligible]
    positive = [(name, w) for name, w in weights if w > 0.0]
    if not positive:
        positive = [(name, float(_multiplier(env))) for name, env in eligible]

    return min(positive, key=lambda nw: (counts.get(nw[0], 0) / nw[1], nw[0]))[0]


def _counts(state: dict[str, Any]) -> dict[str, int]:
    """Per-profile pick ``count`` from picker.json state; non-int entries → 0."""
    picks = state.get("picks", {})
    if not isinstance(picks, dict):
        return {}
    out: dict[str, int] = {}
    for name, entry in picks.items():
        count = entry.get("count") if isinstance(entry, dict) else None
        out[name] = count if isinstance(count, int) and not isinstance(count, bool) else 0
    return out


def _seed_new_entrants(state: dict[str, Any], eligible: list[str]) -> None:
    """Materialize any eligible profile that has no ledger entry at the pool
    minimum — the stride-scheduling new-entrant rule — and persist it.

    The baseline is ``min`` over the counts of eligible profiles already in the
    ledger, defaulting to 0 when none is recorded yet. A genuinely fresh profile
    joining an established pool is seeded at that minimum so it draws no catch-up
    burst; in a cold pool the baseline is 0 and every member round-robins from
    parity. Seeding once (rather than re-crediting on every pick) is what lets a
    never-yet-picked member keep credit 0 while recorded peers advance, so the
    cold-start cycle visits each profile before any repeat. History is never
    reset — a profile already in the ledger keeps its accrued count.
    """
    counts = _counts(state)
    recorded = [counts[name] for name in eligible if name in counts]
    baseline = min(recorded) if recorded else 0
    fresh = [name for name in eligible if name not in counts]
    if not fresh:
        return
    picks = state.setdefault("picks", {})
    if not isinstance(picks, dict):
        picks = {}
        state["picks"] = picks
    state["schema_version"] = PICKER_SCHEMA_VERSION
    for name in fresh:
        entry = picks.get(name)
        if not isinstance(entry, dict):
            entry = {}
            picks[name] = entry
        entry["count"] = baseline


def _record_pick(state: dict[str, Any], chosen: str) -> None:
    """Stamp the chosen profile's last-pick time and bump its count in place.

    The chosen profile already carries a ledger entry — ``_seed_new_entrants``
    has materialized any fresh profile at its pool-minimum baseline before the
    choice — so this is a plain increment of the accrued credit.
    """
    state["schema_version"] = PICKER_SCHEMA_VERSION
    picks = state.setdefault("picks", {})
    if not isinstance(picks, dict):
        picks = {}
        state["picks"] = picks
    existing = picks.get(chosen)
    entry: dict[str, Any] = existing if isinstance(existing, dict) else {}
    if entry is not existing:
        picks[chosen] = entry
    entry["last_picked_at"] = datetime.now().astimezone().isoformat()
    count = entry.get("count", 0)
    entry["count"] = (
        count if isinstance(count, int) and not isinstance(count, bool) else 0
    ) + 1


# ---------- picker.json I/O -------------------------------------------------


def _load_picker_state() -> dict[str, Any]:
    """Read picker.json; empty dict on missing/corrupt/unrecognized version."""
    path = _picker_state_path()
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    if data.get("schema_version") != PICKER_SCHEMA_VERSION:
        return {}
    return data


def _write_picker_state(state: dict[str, Any]) -> None:
    """Atomically replace picker.json (same-filesystem rename)."""
    path = _picker_state_path()
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, indent=2)
            f.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp_name)
        raise


def _load_envelope(path: Path) -> dict[str, Any]:
    """Read a per-account `<id>.json` envelope; empty dict on missing/corrupt."""
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


@contextlib.contextmanager
def _exclusive_lock() -> Iterator[None]:
    """Serialize the picker.json read-modify-write across concurrent launches.

    Locks a dedicated ``picker.json.lock`` file (not picker.json itself, which
    gets replaced by atomic rename) so the lock outlives the data file's inode.
    """
    lock_path = _picker_lock_path()
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
