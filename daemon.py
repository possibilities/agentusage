"""Long-lived per-account scrape daemon.

Run with `uv run python daemon.py` in the foreground. One independent asyncio
loop per account scrapes its target on a `uniform(60, 180)s` jitter and
survives restarts cheaply by sleeping out the remaining `next_fetch_at` window
on boot.

For the on-disk envelope shape, event log format, and client routing contract,
see README.md (the data-format reference). This module is the producer; the
README is the consumer's source of truth.

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

import yaml

import parse_claude_usage
import parse_codex_status
from parse_claude_usage import NoActiveSubscription
from scrape import scrape

# Bumped whenever the envelope's top-level key set or per-field semantics
# change. Clients (the keeper profile-balancer) gate on this — see README.
ENVELOPE_SCHEMA_VERSION = 1


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
TIER_MULTIPLIERS: dict[str, int] = {
    "default_claude_ai": 1,
    "default_claude_max_5x": 5,
    "default_claude_max_20x": 20,
}

# Cap the .claude.json read so a pathological/oversize file never balloons
# memory at boot. Mirror the keeper usage-worker's MAX_USAGE_FILE_BYTES bound;
# 1 MiB is far above any real `oauthAccount` payload.
MAX_CLAUDE_JSON_BYTES = 1024 * 1024


def _xdg_config_home() -> Path:
    """Resolve the XDG config base dir, honoring `XDG_CONFIG_HOME`."""
    env = os.environ.get("XDG_CONFIG_HOME")
    if env:
        return Path(env)
    return Path.home() / ".config"


def _resolve_multiplier(profile: str) -> int:
    """Derive a profile's multiplier from its `.claude.json` tier string.

    Falls back to 1x with a stderr log on any read/parse failure or unknown
    tier — the daemon must never crash on a misconfigured profile.
    """
    path = Path.home() / ".claude-profiles" / profile / ".claude.json"
    try:
        st = path.stat()
        if st.st_size > MAX_CLAUDE_JSON_BYTES:
            print(
                f"[agentuse] {path} exceeds {MAX_CLAUDE_JSON_BYTES} bytes "
                f"({st.st_size}); falling back to 1x",
                file=sys.stderr,
            )
            return 1
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f"[agentuse] cannot read {path} ({exc}); falling back to 1x",
            file=sys.stderr,
        )
        return 1

    tier = data.get("oauthAccount", {}).get("organizationRateLimitTier")
    if tier is None:
        print(
            f"[agentuse] {path} has no oauthAccount.organizationRateLimitTier; "
            f"falling back to 1x",
            file=sys.stderr,
        )
        return 1
    mult = TIER_MULTIPLIERS.get(tier)
    if mult is None:
        print(
            f"[agentuse] {path} has unknown tier {tier!r}; falling back to 1x",
            file=sys.stderr,
        )
        return 1
    return mult


def _load_profile_names() -> list[str]:
    """Read the XDG `agentuse/config.yaml` profile name list.

    Expected shape: `profiles: [name1, name2, ...]` (a top-level YAML list).
    Missing or malformed config logs to stderr and degrades to an empty list,
    so the daemon runs codex-only rather than crashing.
    """
    path = _xdg_config_home() / "agentuse" / "config.yaml"
    if not path.exists():
        print(
            f"[agentuse] no config at {path}; running codex-only",
            file=sys.stderr,
        )
        return []
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except (OSError, yaml.YAMLError) as exc:
        print(
            f"[agentuse] failed to parse {path} ({exc}); running codex-only",
            file=sys.stderr,
        )
        return []
    if not isinstance(data, dict):
        print(
            f"[agentuse] {path} is not a mapping; running codex-only",
            file=sys.stderr,
        )
        return []
    raw = data.get("profiles", [])
    if not isinstance(raw, list):
        print(
            f"[agentuse] {path} `profiles` is not a list; running codex-only",
            file=sys.stderr,
        )
        return []
    names: list[str] = []
    for entry in raw:
        if isinstance(entry, str) and entry:
            names.append(entry)
        else:
            print(
                f"[agentuse] {path} `profiles` entry {entry!r} is not a "
                f"non-empty string; skipping",
                file=sys.stderr,
            )
    return names


def _build_accounts() -> list[Account]:
    """Build the runtime ACCOUNTS registry from the XDG config + tier lookups.

    Each configured profile becomes a claude `Account` with a derived
    multiplier; the codex account is always appended in code (it has no tier
    and no profile dir).
    """
    accounts: list[Account] = []
    for name in _load_profile_names():
        accounts.append(
            {
                "id": name,
                "target": "claude",
                "passthrough": ["--arthack-profile", name],
                "multiplier": _resolve_multiplier(name),
            }
        )
    accounts.append(
        {
            "id": "codex",
            "target": "codex",
            "passthrough": [],
            "multiplier": 1,
        }
    )
    return accounts


ACCOUNTS: list[Account] = _build_accounts()

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


# ---------- Envelope builder ----------------------------------------------


# Canonical key order. Every envelope variant (active, idle, stale, no-sub)
# emits exactly these keys with `null` where the field doesn't apply, so a
# client never has to branch on key presence — only on values.
ENVELOPE_KEYS = (
    "schema_version",
    "id",
    "target",
    "multiplier",
    "status",
    "subscription_active",
    "last_successful_fetch_at",
    "last_skipped_fetch_at",
    "last_failed_fetch_at",
    "next_fetch_at",
    "usage",
    "error",
)


def _build_envelope(
    acct: Account,
    *,
    status: str,
    subscription_active: bool | None,
    usage: dict | None,
    last_successful_fetch_at: str | None,
    last_skipped_fetch_at: str | None,
    last_failed_fetch_at: str | None,
    next_fetch_at: str,
    error: dict | None,
) -> dict:
    """Build an envelope dict with the canonical key set.

    All five writers (active success, no-sub success, idle skip, stale
    failure, restart-cheap reload) go through here so the shape can't drift.
    """
    return {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "id": acct["id"],
        "target": acct["target"],
        "multiplier": acct["multiplier"],
        "status": status,
        "subscription_active": subscription_active,
        "last_successful_fetch_at": last_successful_fetch_at,
        "last_skipped_fetch_at": last_skipped_fetch_at,
        "last_failed_fetch_at": last_failed_fetch_at,
        "next_fetch_at": next_fetch_at,
        "usage": usage,
        "error": error,
    }


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
            #
            # IMPORTANT: never overwrite a `stale` status with `idle`. A
            # failing account needs to keep retrying through quiet periods —
            # if the idle-skip silently flipped its status to `idle`, a
            # client reading the envelope would think the data is good when
            # the last fetch actually failed.
            if state_path.exists():
                prior = _load_envelope(state_path)
                if prior.get("status") != "stale":
                    idle_for = time.time() - _latest_agent_activity()
                    if idle_for > IDLE_THRESHOLD_S:
                        delay = random.uniform(60, 180)
                        next_fetch_at = now + timedelta(seconds=delay)
                        log.info(
                            "idle %.0fs (>%ds) — skipping scrape",
                            idle_for,
                            IDLE_THRESHOLD_S,
                        )
                        # Refresh envelope with skip stamp + next attempt so
                        # the file acts as a liveness heartbeat even when
                        # we're idle. Preserve subscription_active / usage /
                        # last_successful_fetch_at / last_failed_fetch_at
                        # via the canonical builder.
                        envelope = _build_envelope(
                            acct,
                            status="idle",
                            subscription_active=prior.get("subscription_active"),
                            usage=prior.get("usage"),
                            last_successful_fetch_at=prior.get(
                                "last_successful_fetch_at"
                            ),
                            last_skipped_fetch_at=now.isoformat(),
                            last_failed_fetch_at=prior.get("last_failed_fetch_at"),
                            next_fetch_at=next_fetch_at.isoformat(),
                            error=prior.get("error"),
                        )
                        try:
                            write_atomic(state_path, envelope)
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
            # Subscribed claude / codex success: parser returns a usage dict.
            # No-subscription claude: parser raises NoActiveSubscription —
            # we catch that as a SUCCESS (the panel rendered, the account
            # just has no plan limits) and write a no-sub-shaped envelope.
            # Real parse errors propagate out to the except block below.
            try:
                usage = parser(rendered)
                no_subscription = False
            except NoActiveSubscription:
                usage = None
                no_subscription = True
            except Exception as exc:
                setattr(exc, "screen_excerpt", _screen_excerpt(rendered))
                raise

            fetched_at = datetime.now().astimezone()
            delay = random.uniform(60, 180)
            next_fetch_at = fetched_at + timedelta(seconds=delay)

            prior = _load_envelope(state_path)
            # Codex has no subscription concept — always null. Claude
            # success path stamps fresh, overwriting whatever prior said,
            # so an account that upgrades flips false -> true on the next
            # cycle without needing manual cache invalidation.
            if acct["target"] == "claude":
                subscription_active = not no_subscription
            else:
                subscription_active = None
            envelope = _build_envelope(
                acct,
                status="active",
                subscription_active=subscription_active,
                usage=usage,
                last_successful_fetch_at=fetched_at.isoformat(),
                last_skipped_fetch_at=prior.get("last_skipped_fetch_at"),
                last_failed_fetch_at=prior.get("last_failed_fetch_at"),
                next_fetch_at=next_fetch_at.isoformat(),
                error=None,
            )
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
                        "subscription_active": subscription_active,
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
            delay = random.uniform(60, 180)
            next_fetch_at = failed_at + timedelta(seconds=delay)

            # Two files on failure:
            #
            # 1) `<id>.error.json` — verbose sidecar for human debugging
            #    keeps `screen_excerpt` (could be hundreds of lines, useful
            #    when format-drift triggers a parse failure).
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

            # 2) `<id>.json` — main envelope stamped `status: "stale"` with a
            #    CONCISE `error` (no screen_excerpt) so a client polling
            #    one file always sees freshness signal. Preserve last-good
            #    usage / subscription_active / last_successful_fetch_at
            #    from prior — on a first-ever failure with no prior, those
            #    stay null.
            prior = _load_envelope(state_path)
            concise_error = {
                "type": type(exc).__name__,
                "message": str(exc),
                "at": failed_at.isoformat(),
            }
            stale_envelope = _build_envelope(
                acct,
                status="stale",
                subscription_active=prior.get("subscription_active"),
                usage=prior.get("usage"),
                last_successful_fetch_at=prior.get("last_successful_fetch_at"),
                last_skipped_fetch_at=prior.get("last_skipped_fetch_at"),
                last_failed_fetch_at=failed_at.isoformat(),
                next_fetch_at=next_fetch_at.isoformat(),
                error=concise_error,
            )
            try:
                write_atomic(state_path, stale_envelope)
            except Exception as write_exc:
                log.error("failed to write stale main envelope: %s", write_exc)

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
            await asyncio.sleep(delay)


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
