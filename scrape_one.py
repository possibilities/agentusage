"""Run a single account's scrape outside the daemon for iterative debugging.

Usage:
    uv run python scrape_one.py <account-id>

where <account-id> is one of the ids in daemon.ACCOUNTS (e.g. claude-default,
claude-multi-1, claude-multi-2, claude-multi-3, codex).

Prints the parsed envelope JSON on success, or the raw rendered screen on
failure. Touches no state files. Exits non-zero on any error.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime

from daemon import ACCOUNTS, ENVELOPE_SCHEMA_VERSION, PARSERS
from parse_claude_usage import NoActiveSubscription
from scrape import scrape


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: uv run python scrape_one.py <account-id>", file=sys.stderr)
        print(
            "  ids: " + " ".join(a["id"] for a in ACCOUNTS),
            file=sys.stderr,
        )
        return 2

    wanted = sys.argv[1]
    acct = next((a for a in ACCOUNTS if a["id"] == wanted), None)
    if acct is None:
        print(f"unknown account-id: {wanted!r}", file=sys.stderr)
        print(
            "  ids: " + " ".join(a["id"] for a in ACCOUNTS),
            file=sys.stderr,
        )
        return 2

    parser = PARSERS[acct["target"]]

    started = datetime.now().astimezone()
    print(f"[{started.isoformat()}] scraping {acct['id']}...", file=sys.stderr)

    rendered = scrape(acct["target"], acct["passthrough"])

    # Mirror daemon.py's branching: NoActiveSubscription is a SUCCESS with
    # usage=None / subscription_active=False, not a parse failure. Anything
    # else (real format drift, panel never rendered) prints the screen so
    # a human can diagnose.
    try:
        usage = parser(rendered)
        no_subscription = False
    except NoActiveSubscription:
        usage = None
        no_subscription = True
    except Exception as exc:
        print(f"PARSE FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("--- rendered screen ---", file=sys.stderr)
        for i, line in enumerate(rendered.splitlines()):
            if line.strip():
                print(f"{i:3d} | {line}", file=sys.stderr)
        return 1

    done = datetime.now().astimezone()
    print(
        f"[{done.isoformat()}] ok ({(done - started).total_seconds():.1f}s)",
        file=sys.stderr,
    )
    # Mirror daemon._build_envelope shape so this tool stays useful as a
    # spec reference for client devs. Codex never has a subscription concept.
    if acct["target"] == "claude":
        subscription_active: bool | None = not no_subscription
    else:
        subscription_active = None
    print(
        json.dumps(
            {
                "schema_version": ENVELOPE_SCHEMA_VERSION,
                "id": acct["id"],
                "target": acct["target"],
                "multiplier": acct["multiplier"],
                "status": "active",
                "subscription_active": subscription_active,
                "last_successful_fetch_at": started.isoformat(),
                "last_skipped_fetch_at": None,
                "last_failed_fetch_at": None,
                "next_fetch_at": None,
                "usage": usage,
                "error": None,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
