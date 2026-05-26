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

PARSERS = {
    "claude": parse_claude_usage.parse,
    "codex": parse_codex_status.parse,
}


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


async def account_loop(acct: Account, executor: ThreadPoolExecutor) -> None:
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
            fetched_at = datetime.now().astimezone()

            # pexpect is blocking and runs in a thread. asyncio.wait_for caps
            # the await, but the underlying executor thread cannot be cancelled
            # by Python — a wedged scrape finishes naturally on its own.
            rendered = await asyncio.wait_for(
                loop.run_in_executor(
                    executor, scrape, acct["target"], acct["passthrough"]
                ),
                timeout=60,
            )
            usage = parser(rendered)
            next_fetch_at = fetched_at + timedelta(seconds=delay)

            envelope = {
                "id": acct["id"],
                "target": acct["target"],
                "multiplier": acct["multiplier"],
                "fetched_at": fetched_at.isoformat(),
                "next_fetch_at": next_fetch_at.isoformat(),
                "usage": usage,
            }
            write_atomic(state_path, envelope)
            error_path.unlink(missing_ok=True)
            log.info("wrote, next_fetch_at=%s", next_fetch_at.isoformat())

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

    # Strong refs — the event loop only holds weak refs to tasks otherwise.
    tasks = {
        asyncio.create_task(account_loop(acct, executor), name=acct["id"])
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
