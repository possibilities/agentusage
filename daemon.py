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
import subprocess
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
        "id": "default",
        "target": "claude",
        "passthrough": ["--arthack-profile", "default"],
        "multiplier": 5,
    },
    {
        "id": "multi-claude-1",
        "target": "claude",
        "passthrough": ["--arthack-profile", "multi-claude-1"],
        "multiplier": 1,
    },
    {
        "id": "multi-claude-2",
        "target": "claude",
        "passthrough": ["--arthack-profile", "multi-claude-2"],
        "multiplier": 1,
    },
    {
        "id": "multi-claude-3",
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

# Be conservative with upstream agent processes. This also reduces local
# contention: on a slow machine, queued account loops otherwise fire back to
# back as soon as the target lock opens.
MIN_PROFILE_USE_INTERVAL_S = 60.0

# Slow boots and long-loading status panels are expected when the system is
# under pressure. The scrape implementation has its own sentinel deadline; this
# outer cap is just the daemon's guardrail for a wedged child.
SCRAPE_TIMEOUT_S = 240.0

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


def _screen_excerpt(rendered: str, *, max_lines: int = 24) -> list[str]:
    """Compact nonblank rendered screen lines for diagnosing parse failures."""
    lines = [line.rstrip()[:240] for line in rendered.splitlines() if line.strip()]
    if len(lines) <= max_lines:
        return lines
    head = max_lines // 2
    tail = max_lines - head - 1
    omitted = len(lines) - head - tail
    return lines[:head] + [f"... {omitted} lines omitted ..."] + lines[-tail:]


async def _wait_for_profile_gate(
    gate_state: dict[str, float],
    log: logging.Logger,
) -> None:
    """Keep profile launches at least 60s apart.

    Call while holding profile_gate_lock, which also serializes live TUI
    processes globally.
    """
    now = time.monotonic()
    wait_for = gate_state["next_allowed_at"] - now
    if wait_for > 0:
        log.info("profile gate sleeping %.1fs", wait_for)
        await asyncio.sleep(wait_for)
    gate_state["next_allowed_at"] = time.monotonic() + MIN_PROFILE_USE_INTERVAL_S


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


NOTIFYCTL = "/Users/mike/.local/bin/notifyctl"


def _notify_consecutive_failure(
    acct: Account, exc: Exception, log: logging.Logger
) -> None:
    """Fire a desktop notification on the 2nd consecutive scrape failure.

    Fire-and-forget — we Popen without wait. If notifyctl is missing or
    fails the daemon keeps going; we log and move on.
    """
    title = f"agentuse: {acct['id']} failing"
    message = f"{type(exc).__name__}: {exc}"
    try:
        subprocess.Popen(
            [
                NOTIFYCTL,
                "show-message",
                "-t",
                title,
                "-m",
                message,
                "--sound",
                "Ping",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, OSError) as notify_exc:
        log.warning("notifyctl unavailable: %s", notify_exc)


async def account_loop(
    acct: Account,
    executor: ThreadPoolExecutor,
    target_lock: asyncio.Lock,
    profile_gate_lock: asyncio.Lock,
    profile_gate_state: dict[str, float],
    events_lock: asyncio.Lock,
) -> None:
    log = logging.getLogger(f"agentuse.{acct['id']}")
    loop = asyncio.get_running_loop()
    parser = PARSERS[acct["target"]]
    state_path = _state_path(acct)
    error_path = _error_path(acct)

    # Count of consecutive scrape failures for this account. Reset on success;
    # we fire a notifyctl exactly once per streak when this hits 2 — so a
    # one-off transient failure stays quiet, but a real outage gets a desktop
    # notification on the SECOND consecutive miss.
    consecutive_failures = 0

    initial = _initial_delay(acct, log)
    log.info("startup sleep %.1fs", initial)
    await asyncio.sleep(initial)

    while True:
        try:
            now = datetime.now().astimezone()

            # Skip the scrape when no agent has touched its log within the idle
            # window — the prior envelope's `usage` values are still current,
            # since no agent has burned quota since. Bootstrap by always
            # scraping when no envelope exists yet.
            if state_path.exists():
                idle_for = time.time() - _latest_agent_activity()
                if idle_for > IDLE_THRESHOLD_S:
                    delay = random.uniform(60, 180)
                    next_fetch_at = now + timedelta(seconds=delay)
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
                async with profile_gate_lock:
                    await _wait_for_profile_gate(profile_gate_state, log)
                    # pexpect is blocking and runs in a thread. asyncio.wait_for caps
                    # the await, but the underlying executor thread cannot be cancelled
                    # by Python — a wedged scrape finishes naturally on its own.
                    rendered = await asyncio.wait_for(
                        loop.run_in_executor(
                            executor, scrape, acct["target"], acct["passthrough"]
                        ),
                        timeout=SCRAPE_TIMEOUT_S,
                    )
            try:
                usage = parser(rendered)
            except Exception as exc:
                setattr(exc, "screen_excerpt", _screen_excerpt(rendered))
                raise

            fetched_at = datetime.now().astimezone()
            delay = random.uniform(60, 180)
            next_fetch_at = fetched_at + timedelta(seconds=delay)

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
            consecutive_failures = 0
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
            screen_excerpt = getattr(exc, "screen_excerpt", None)
            if screen_excerpt:
                error_envelope["screen_excerpt"] = screen_excerpt
            try:
                write_atomic(error_path, error_envelope)
            except Exception as write_exc:
                log.error("failed to write error file: %s", write_exc)
            log.error("error: %s", exc)
            consecutive_failures += 1
            async with events_lock:
                _append_event(
                    {
                        "ts": failed_at.isoformat(),
                        "id": acct["id"],
                        "target": acct["target"],
                        "event": "scrape_failed",
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                        "consecutive_failures": consecutive_failures,
                        **(
                            {"screen_excerpt": screen_excerpt} if screen_excerpt else {}
                        ),
                    },
                    log,
                )
            # Notify exactly once per failure streak — when we hit the 2nd
            # consecutive miss, not on every subsequent miss, so a sustained
            # outage doesn't spam the desktop.
            if consecutive_failures == 2:
                _notify_consecutive_failure(acct, exc, log)
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
    profile_gate_lock = asyncio.Lock()
    profile_gate_state = {"next_allowed_at": 0.0}

    # Single shared lock for events.jsonl appends. POSIX guarantees atomic
    # appends < PIPE_BUF; the lock keeps semantics explicit and tidies up
    # ordering when multiple loops want to write at the same instant.
    events_lock = asyncio.Lock()

    # Strong refs — the event loop only holds weak refs to tasks otherwise.
    tasks = {
        asyncio.create_task(
            account_loop(
                acct,
                executor,
                target_locks[acct["target"]],
                profile_gate_lock,
                profile_gate_state,
                events_lock,
            ),
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
