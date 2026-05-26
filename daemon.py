"""Long-lived per-account scrape daemon.

Run with `uv run python daemon.py` in the foreground. One independent asyncio
loop per account scrapes its target on a `uniform(60, 180)s` jitter, writes a
self-stamped JSON envelope to `~/.local/state/agentuse/<id>.json`, and survives
restarts cheaply by sleeping out the remaining `next_fetch_at` window on boot.

Ctrl-C (SIGINT) or SIGTERM cancels all loops with a 30s grace. No PID file,
no launchd unit, no daemonization.

Note: there is no cross-instance lock — two daemons would race the same state
files. Out of scope for this epic. Run one at a time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import signal
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import TypedDict

import parse_claude_usage
import parse_codex_status
from scrape import scrape


class Account(TypedDict):
    id: str
    target: str
    passthrough: list[str]
    multiplier: int


# ---------- ACCOUNTS registry ----------------------------------------------

# Multipliers map plan tier strings (source-of-truth:
#   ~/.claude-profiles/<p>/.claude.json:oauthAccount.organizationRateLimitTier
# `default_claude_ai` -> Pro (1x), `default_claude_max_5x` -> Max (5x),
# `default_claude_max_20x` -> Max (20x). Codex has no tier; treat as 1x.
ACCOUNTS: list[Account] = [
    {
        "id": "claude-default",
        "target": "claude",
        "passthrough": ["--arthack-profile", "default"],
        "multiplier": 5,
    },
    {
        "id": "claude-multi-1",
        "target": "claude",
        "passthrough": ["--arthack-profile", "multi-claude-1"],
        "multiplier": 1,
    },
    {
        "id": "claude-multi-2",
        "target": "claude",
        "passthrough": ["--arthack-profile", "multi-claude-2"],
        "multiplier": 1,
    },
    {
        "id": "claude-multi-3",
        "target": "claude",
        "passthrough": ["--arthack-profile", "multi-claude-3"],
        "multiplier": 20,
    },
    {
        "id": "codex",
        "target": "codex",
        "passthrough": [],
        "multiplier": 1,
    },
]

assert len({a["id"] for a in ACCOUNTS}) == len(ACCOUNTS), "ACCOUNTS ids must be unique"

STATE_DIR = Path.home() / ".local" / "state" / "agentuse"

# One-line-per-event audit log of every scrape and every idle-skip across all
# accounts. Unbounded growth; rotation is a future concern when it matters.
EVENTS_LOG = STATE_DIR / "events.jsonl"

# Pause scraping when no agent has written to its session log within this window.
# Appended jsonl mtimes are the signal — parent dir mtimes don't update on appends,
# only on session start/end. 15 min covers think-pauses and brief breaks.
IDLE_THRESHOLD_S = 15 * 60

PARSERS = {
    "claude": parse_claude_usage.parse,
    "codex": parse_codex_status.parse,
}


def _latest_agent_activity() -> float:
    """Newest mtime across claude + codex session logs; 0.0 if none.

    Claude profiles all symlink projects/ to ~/.claude/projects, so one walk
    covers every claude account. Codex writes per-session rollouts under
    sessions/YYYY/MM/DD/. Paths containing 'agentuse-scrape-' are filtered as
    a defensive measure — empirically /usage and /status don't materialize
    session files, but a future scrape change shouldn't accidentally keep the
    daemon awake.
    """
    newest = 0.0
    for root in (
        Path.home() / ".claude" / "projects",
        Path.home() / ".codex" / "sessions",
    ):
        if not root.exists():
            continue
        for p in root.rglob("*.jsonl"):
            if "agentuse-scrape-" in str(p):
                continue
            try:
                newest = max(newest, p.stat().st_mtime)
            except OSError:
                continue
    return newest


# ---------- Atomic write ----------------------------------------------------


def write_atomic(path: Path, payload: dict) -> None:
    """Write `payload` as JSON to `path` atomically (same-filesystem rename)."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        # Best-effort cleanup; if replace already moved it the unlink is a noop.
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _load_envelope(path: Path) -> dict:
    """Read prior envelope JSON; empty dict on missing/corrupt."""
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


# ---------- Events audit log -----------------------------------------------


def _append_event(payload: dict, log: logging.Logger) -> None:
    """Append one event line to EVENTS_LOG. Failures are logged, not raised —
    the audit trail should never block the scrape pipeline.
    """
    try:
        with open(EVENTS_LOG, "a") as f:
            f.write(json.dumps(payload) + "\n")
    except OSError as exc:
        log.warning("failed to append event: %s", exc)


# ---------- Per-account scheduling loop ------------------------------------


def _state_path(acct: Account) -> Path:
    return STATE_DIR / f"{acct['id']}.json"


def _error_path(acct: Account) -> Path:
    return STATE_DIR / f"{acct['id']}.error.json"


def _initial_delay(acct: Account, log: logging.Logger) -> float:
    """How long to sleep before this account's first scrape after boot.

    If a prior `<id>.json` records a `next_fetch_at` in the future, sleep the
    remainder. Otherwise (no file, parse failure, or stale stamp) jitter cold-
    boot by `uniform(0, 60)s` so all accounts don't fire at t=0.
    """
    path = _state_path(acct)
    if not path.exists():
        return random.uniform(0, 60)
    try:
        with open(path) as f:
            prior = json.load(f)
        next_fetch = datetime.fromisoformat(prior["next_fetch_at"])
    except (OSError, ValueError, KeyError) as exc:
        log.info("ignoring unparseable prior state (%s); cold-boot jitter", exc)
        return random.uniform(0, 60)

    now = datetime.now().astimezone()
    remaining = (next_fetch - now).total_seconds()
    if remaining > 0:
        log.info(
            "restart-cheap: sleeping %.1fs until next_fetch_at=%s",
            remaining,
            next_fetch.isoformat(),
        )
        return remaining
    return random.uniform(0, 60)


async def account_loop(
    acct: Account,
    executor: ThreadPoolExecutor,
    target_lock: asyncio.Lock,
    events_lock: asyncio.Lock,
) -> None:
    log = logging.getLogger(f"agentuse.{acct['id']}")
    loop = asyncio.get_running_loop()
    parser = PARSERS[acct["target"]]
    state_path = _state_path(acct)
    error_path = _error_path(acct)

    initial = _initial_delay(acct, log)
    log.info("startup sleep %.1fs", initial)
    await asyncio.sleep(initial)

    while True:
        try:
            # Jitter at the start of the cycle so the measured interval is
            # uniform-random and not uniform-random-plus-scrape-duration.
            delay = random.uniform(60, 180)
            now = datetime.now().astimezone()
            next_fetch_at = now + timedelta(seconds=delay)

            # Skip the scrape when no agent has touched its log within the idle
            # window — the prior envelope's `usage` values are still current,
            # since no agent has burned quota since. Bootstrap by always
            # scraping when no envelope exists yet.
            if state_path.exists():
                idle_for = time.time() - _latest_agent_activity()
                if idle_for > IDLE_THRESHOLD_S:
                    log.info(
                        "idle %.0fs (>%ds) — skipping scrape",
                        idle_for,
                        IDLE_THRESHOLD_S,
                    )
                    # Refresh envelope with skip stamp + next attempt so the
                    # file acts as a liveness heartbeat even when we're idle.
                    prior = _load_envelope(state_path)
                    prior.update(
                        {
                            "id": acct["id"],
                            "target": acct["target"],
                            "multiplier": acct["multiplier"],
                            "last_skipped_fetch_at": now.isoformat(),
                            "next_fetch_at": next_fetch_at.isoformat(),
                        }
                    )
                    try:
                        write_atomic(state_path, prior)
                    except OSError as exc:
                        log.warning("failed to write skip envelope: %s", exc)
                    async with events_lock:
                        _append_event(
                            {
                                "ts": now.isoformat(),
                                "id": acct["id"],
                                "target": acct["target"],
                                "event": "idle_skipped",
                                "idle_for_s": round(idle_for, 1),
                                "next_fetch_at": next_fetch_at.isoformat(),
                            },
                            log,
                        )
                    await asyncio.sleep(delay)
                    continue

            # Serialize scrapes per target so concurrent claude TUI spawns
            # don't starve each other (multiple Ink processes booting in
            # parallel race for terminal/CPU and lose slash-command keystrokes).
            async with target_lock:
                # pexpect is blocking and runs in a thread. asyncio.wait_for caps
                # the await, but the underlying executor thread cannot be cancelled
                # by Python — a wedged scrape finishes naturally on its own.
                rendered = await asyncio.wait_for(
                    loop.run_in_executor(
                        executor, scrape, acct["target"], acct["passthrough"]
                    ),
                    timeout=120,
                )
            usage = parser(rendered)
            fetched_at = now

            prior = _load_envelope(state_path)
            envelope = {
                "id": acct["id"],
                "target": acct["target"],
                "multiplier": acct["multiplier"],
                "last_successful_fetch_at": fetched_at.isoformat(),
                "last_skipped_fetch_at": prior.get("last_skipped_fetch_at"),
                "next_fetch_at": next_fetch_at.isoformat(),
                "usage": usage,
            }
            write_atomic(state_path, envelope)
            error_path.unlink(missing_ok=True)
            log.info("wrote, next_fetch_at=%s", next_fetch_at.isoformat())
            async with events_lock:
                _append_event(
                    {
                        "ts": fetched_at.isoformat(),
                        "id": acct["id"],
                        "target": acct["target"],
                        "event": "scraped",
                        "next_fetch_at": next_fetch_at.isoformat(),
                        "usage": usage,
                    },
                    log,
                )

            sleep_for = (next_fetch_at - datetime.now().astimezone()).total_seconds()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failed_at = datetime.now().astimezone()
            error_envelope = {
                "id": acct["id"],
                "target": acct["target"],
                "multiplier": acct["multiplier"],
                "failed_at": failed_at.isoformat(),
                "error_type": type(exc).__name__,
                "message": str(exc),
            }
            try:
                write_atomic(error_path, error_envelope)
            except Exception as write_exc:
                log.error("failed to write error file: %s", write_exc)
            log.error("error: %s", exc)
            async with events_lock:
                _append_event(
                    {
                        "ts": failed_at.isoformat(),
                        "id": acct["id"],
                        "target": acct["target"],
                        "event": "scrape_failed",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                    },
                    log,
                )
            await asyncio.sleep(random.uniform(60, 180))


# ---------- Supervisor ------------------------------------------------------


async def main() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    log = logging.getLogger("agentuse.main")
    log.info("starting daemon with %d accounts; state_dir=%s", len(ACCOUNTS), STATE_DIR)

    executor = ThreadPoolExecutor(max_workers=len(ACCOUNTS) + 1)
    loop = asyncio.get_running_loop()
    loop.set_default_executor(executor)

    shutdown_event = asyncio.Event()

    def _signal_shutdown(sig: signal.Signals) -> None:
        log.info("received %s, initiating shutdown", sig.name)
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_shutdown, sig)

    # One lock per target ("claude", "codex", ...) so same-target scrapes
    # serialize but different targets run in parallel.
    target_locks: dict[str, asyncio.Lock] = {
        t: asyncio.Lock() for t in {a["target"] for a in ACCOUNTS}
    }

    # Single shared lock for events.jsonl appends. POSIX guarantees atomic
    # appends < PIPE_BUF; the lock keeps semantics explicit and tidies up
    # ordering when multiple loops want to write at the same instant.
    events_lock = asyncio.Lock()

    # Strong refs — the event loop only holds weak refs to tasks otherwise.
    tasks = {
        asyncio.create_task(
            account_loop(acct, executor, target_locks[acct["target"]], events_lock),
            name=acct["id"],
        )
        for acct in ACCOUNTS
    }

    await shutdown_event.wait()

    for task in tasks:
        task.cancel()

    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=30,
        )
    except asyncio.TimeoutError:
        log.warning("shutdown grace expired; exiting with tasks still in-flight")

    # Don't wait on the executor — pexpect children get reaped by process exit.
    executor.shutdown(wait=False, cancel_futures=True)
    log.info("clean shutdown complete")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s [%(name)s] %(message)s",
    )
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # asyncio.run already drained on SIGINT via add_signal_handler; this is
        # belt-and-suspenders for environments where the handler didn't engage.
        pass
