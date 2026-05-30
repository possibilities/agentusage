"""Profile picker — the client-side balancer the README's data contract feeds.

The daemon (`daemon.py`) is the *producer*: it scrapes each account and writes
`~/.local/state/agentuse/<id>.json` envelopes. This module is the first
*consumer* — the dumb balancer an external launcher (arthack's claude wrapper)
calls to answer one question: **"which Claude profile should I use right now?"**

Two public functions, both fail-open and side-effect-light so importing this
module never spins up the daemon's account registry:

- ``pick_profile() -> str`` — round-robin over subscribed Claude accounts.
- ``list_profiles() -> list[str]`` — the configured Claude profile names.

`pick_profile` is deliberately dumb (v1):

- **Eligible** = a configured profile whose envelope says ``target == "claude"``
  and ``subscription_active is True``. No subscription (or no envelope yet, or
  unknown) → not eligible. Usage percentages and ``multiplier`` are ignored —
  that is what keeps this round-robin and not balancing. There is **no stale
  filter**: a ``status == "stale"`` account still rotates.
- **Round-robin** = pick the eligible profile with the oldest ``last_picked_at``
  (never-picked sorts oldest). A least-recently-picked cursor rather than an
  integer index, because the eligible set isn't stable — subscriptions lapse,
  the daemon goes stale, accounts come and go, and an index into a changing
  list points at the wrong thing the moment the set shifts.
- **Fail-open** = any failure (no eligible profile, unreadable state, lock
  trouble, corrupt JSON) returns ``"default"``. The function never raises; a
  broken picker must never block a launch. ``"default"`` is itself a real
  account id, so the fallback and a legitimate pick are the same string.

The pick is recorded in ``~/.local/state/agentuse/picker.json`` — the "activity
log" that tells the next call which profile to rotate to. The read-modify-write
is serialized with an `fcntl` lock so two concurrent launches can't both draw
the same profile and defeat the rotation.
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
    """Round-robin over subscribed Claude accounts; ``"default"`` if none.

    Never raises — every failure path returns ``DEFAULT_PROFILE``.
    """
    try:
        return _pick_profile()
    except Exception:
        return DEFAULT_PROFILE


def _pick_profile() -> str:
    eligible = _eligible_profiles()
    if not eligible:
        return DEFAULT_PROFILE

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with _exclusive_lock():
        state = _load_picker_state()
        chosen = _choose(eligible, state)
        _record_pick(state, chosen)
        _write_picker_state(state)
    return chosen


def _eligible_profiles() -> list[str]:
    """Configured profiles confirmed to have an active Claude subscription.

    A profile qualifies only when its envelope exists and says it is a
    subscribed claude account. Missing envelope (daemon hasn't scraped yet) or
    ``subscription_active`` anything other than ``True`` → excluded. No status
    check — stale accounts still rotate (v1 decision).
    """
    eligible: list[str] = []
    for name in list_profiles():
        envelope = _load_envelope(STATE_DIR / f"{name}.json")
        if envelope.get("target") != "claude":
            continue
        if envelope.get("subscription_active") is True:
            eligible.append(name)
    return eligible


def _choose(eligible: list[str], state: dict[str, Any]) -> str:
    """Least-recently-picked eligible profile; ties broken by name."""
    picks = state.get("picks", {})
    if not isinstance(picks, dict):
        picks = {}
    return min(eligible, key=lambda name: _pick_sort_key(name, picks))


def _pick_sort_key(name: str, picks: dict[str, Any]) -> tuple[float, str]:
    """(last-pick epoch, name). Never-picked / unparseable → epoch 0.0 (oldest).

    Parsed to a timestamp rather than compared as ISO strings so a DST offset
    shift between two stamps can't reorder them.
    """
    entry = picks.get(name)
    ts_raw = entry.get("last_picked_at") if isinstance(entry, dict) else None
    if not isinstance(ts_raw, str):
        return (0.0, name)
    try:
        return (datetime.fromisoformat(ts_raw).timestamp(), name)
    except ValueError:
        return (0.0, name)


def _record_pick(state: dict[str, Any], chosen: str) -> None:
    """Stamp the chosen profile's last-pick time and bump its count in place."""
    state["schema_version"] = PICKER_SCHEMA_VERSION
    picks = state.setdefault("picks", {})
    if not isinstance(picks, dict):
        picks = {}
        state["picks"] = picks
    entry = picks.get(chosen)
    if not isinstance(entry, dict):
        entry = {"last_picked_at": None, "count": 0}
        picks[chosen] = entry
    entry["last_picked_at"] = datetime.now().astimezone().isoformat()
    count = entry.get("count", 0)
    entry["count"] = (count if isinstance(count, int) else 0) + 1


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
