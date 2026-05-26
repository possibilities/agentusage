"""Run all five scrape jobs sequentially, parse the claude /usage panels,
and dump the aggregate to a stable /tmp JSON path.

Four claude scrapes across arthack profiles, then one codex scrape.
"""
import json
import subprocess
import sys
from pathlib import Path

from parse_claude_usage import ClaudeUsageParseError, parse

HERE = Path(__file__).parent
SCRAPE = HERE / "scrape.py"
USAGE_OUTPUT = Path("/tmp/tuiuse-usage.json")

CLAUDE_PROFILES = ["default", "multi-claude-1", "multi-claude-2", "multi-claude-3"]

JOBS = [
    ("claude", profile, ["--arthack-profile", profile]) for profile in CLAUDE_PROFILES
] + [
    ("codex", None, []),
]


def run_job(target, passthrough):
    cmd = ["uv", "run", "python", str(SCRAPE), target]
    if passthrough:
        cmd.append("--")
        cmd.extend(passthrough)
    print(f"--- running: {' '.join(cmd[3:])}", file=sys.stderr, flush=True)
    result = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(f"job failed: {target} {passthrough}")
    return result.stdout.strip().splitlines()[-1]


def main():
    paths = []
    usage = {}
    for target, profile, passthrough in JOBS:
        path = run_job(target, passthrough)
        paths.append(path)
        if target == "claude":
            text = Path(path).read_text()
            try:
                usage[profile] = parse(text)
            except ClaudeUsageParseError as err:
                raise SystemExit(
                    f"parse failed for profile {profile!r}: {err}\nfile: {path}"
                )

    USAGE_OUTPUT.write_text(json.dumps(usage, indent=2) + "\n")

    print("\nAll dumps:")
    for p in paths:
        print(p)
    print(f"\nAggregate: {USAGE_OUTPUT}")


if __name__ == "__main__":
    main()
