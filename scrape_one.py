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

from daemon import ACCOUNTS, PARSERS
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

    try:
        usage = parser(rendered)
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
    print(
        json.dumps(
            {
                "id": acct["id"],
                "target": acct["target"],
                "multiplier": acct["multiplier"],
                "fetched_at": started.isoformat(),
                "usage": usage,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
