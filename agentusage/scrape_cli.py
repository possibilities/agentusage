"""Stateless one-shot scrape CLI — scrape+parse ONLY, no state, no orchestration.

Invoked once per account by the keeper usage-scraper-worker:

    python -m agentusage.scrape_cli --target <claude|codex> --profile <name> \\
        [--command <path>] [--rows N] [--cols M]

Does exactly one scrape and prints ONE discriminated JSON object on stdout.
ALL diagnostics / tracebacks go to stderr. The tier/multiplier resolution and
envelope assembly (multiplier, next_fetch_at, last_*_fetch_at, lift_at carry)
live in the TS worker, NOT here — this util is scrape+parse only.

JSON contract (stdout is exactly one of these objects, nothing else):

    ok / subscribed:
        {schema_version, status:"ok",
         usage:{session, week[, sonnet_week][, codex_spark_session, codex_spark_week]},
         subscription_active}

    ok / no_subscription (the NoActiveSubscription SUCCESS arm — claude only):
        {schema_version, status:"ok", no_subscription:true}

    error (parse drift, panel never rendered, scrape crash):
        {schema_version, status:"error", error_type, message, screen_excerpt}

Arm-to-exit-code mapping (getting this wrong corrupts the worker's branch logic):

    ok (subscribed)         exit 0
    ok (no_subscription)    exit 0   <- NoActiveSubscription is a SUCCESS, not an error
    error                   exit 1

`subscription_active` is True for a subscribed claude scrape, None for codex
(no subscription concept). The no_subscription arm omits `usage` /
`subscription_active` entirely — its presence IS the no-sub signal.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

# Make the flat repo-root modules (scrape, parse_*) importable regardless of the
# caller's cwd. The package lives at <repo>/agentusage/; the scrape mechanics and
# parsers lay flat at <repo>/. `python -m agentusage.scrape_cli` puts the repo
# root on sys.path only when cwd is the repo root, so bootstrap it explicitly.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import parse_claude_usage  # noqa: E402
import parse_codex_status  # noqa: E402
from parse_claude_usage import NoActiveSubscription  # noqa: E402
from scrape import scrape  # noqa: E402

# Bumped whenever the contract's top-level key set or per-field semantics change.
# The keeper worker gates on this integer. Independent of the on-disk ENVELOPE
# schema version (the worker owns the envelope; this util owns only the scrape
# contract).
SCHEMA_VERSION = 1

PARSERS = {
    "claude": parse_claude_usage.parse,
    "codex": parse_codex_status.parse,
}


def _screen_excerpt(rendered: str, *, max_lines: int = 24) -> list[str]:
    """Compact nonblank rendered screen lines for diagnosing parse failures.

    Head + tail with an elided middle so a huge panel can't balloon the JSON
    while still surfacing the rows a human needs to diagnose format drift.
    """
    lines = [line.rstrip()[:240] for line in rendered.splitlines() if line.strip()]
    if len(lines) <= max_lines:
        return lines
    head = max_lines // 2
    tail = max_lines - head - 1
    omitted = len(lines) - head - tail
    return lines[:head] + [f"... {omitted} lines omitted ..."] + lines[-tail:]


def _passthrough_for(target: str, profile: str) -> list[str]:
    """Translate --profile into scrape()'s passthrough args.

    `scrape()` selects the claude profile by stripping `--agentwrap-profile
    <name>` into a CLAUDE_CONFIG_DIR env var. Codex has no profile concept and
    takes no passthrough.
    """
    if target == "claude" and profile != "default":
        return ["--agentwrap-profile", profile]
    return []


def _ok_subscribed(usage: dict, subscription_active: bool | None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "usage": usage,
        "subscription_active": subscription_active,
    }


def _ok_no_subscription() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "no_subscription": True,
    }


def _error(error_type: str, message: str, screen_excerpt: list[str]) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "error_type": error_type,
        "message": message,
        "screen_excerpt": screen_excerpt,
    }


def _emit(payload: dict) -> None:
    """Print exactly one JSON object on stdout and flush before exit.

    The worker reads stdout as a single JSON object; a buffered, unflushed
    stdout inside a Bun Worker can read back empty (Bun#24690), so flush is
    mandatory, not cosmetic.
    """
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def run(target: str, profile: str, command: str | None, rows: int | None, cols: int | None) -> int:
    """Scrape one account, emit one JSON object, return the process exit code."""
    parser = PARSERS[target]
    passthrough = _passthrough_for(target, profile)

    # The scrape itself can fail before any screen renders (binary missing,
    # PTY error). Treat that as the error arm with an empty excerpt.
    try:
        rendered = scrape(target, passthrough, command=command, rows=rows, cols=cols)
    except Exception as exc:  # noqa: BLE001 — any scrape failure maps to the error arm
        traceback.print_exc(file=sys.stderr)
        _emit(_error(type(exc).__name__, str(exc), []))
        return 1

    # Branch the parse the same way the daemon did: NoActiveSubscription is a
    # SUCCESS (panel rendered, account just has no plan limits), everything else
    # is real parse failure / format drift.
    try:
        usage = parser(rendered)
    except NoActiveSubscription:
        _emit(_ok_no_subscription())
        return 0
    except Exception as exc:  # noqa: BLE001 — parse drift -> error arm
        traceback.print_exc(file=sys.stderr)
        _emit(_error(type(exc).__name__, str(exc), _screen_excerpt(rendered)))
        return 1

    # Codex has no subscription concept (null); a subscribed claude scrape is
    # always subscription_active=True (the no-sub case raised above).
    subscription_active: bool | None = True if target == "claude" else None
    _emit(_ok_subscribed(usage, subscription_active))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="agentusage.scrape_cli",
        description="One-shot usage scrape; prints one discriminated JSON object.",
    )
    ap.add_argument("--target", required=True, choices=["claude", "codex"])
    ap.add_argument("--profile", required=True, help="account/profile name")
    ap.add_argument("--command", default=None, help="override the binary to spawn")
    ap.add_argument("--rows", type=int, default=None, help="PTY rows (default pinned)")
    ap.add_argument("--cols", type=int, default=None, help="PTY cols (default pinned)")
    args = ap.parse_args(argv)

    return run(
        target=args.target,
        profile=args.profile,
        command=args.command,
        rows=args.rows,
        cols=args.cols,
    )


if __name__ == "__main__":
    sys.exit(main())
