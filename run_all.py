"""Run all five scrape jobs sequentially and print the resulting file paths.

Four claude scrapes across arthack profiles, then one codex scrape.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SCRAPE = HERE / "scrape.py"

JOBS = [
    ("claude", ["--arthack-profile", "default"]),
    ("claude", ["--arthack-profile", "multi-claude-1"]),
    ("claude", ["--arthack-profile", "multi-claude-2"]),
    ("claude", ["--arthack-profile", "multi-claude-3"]),
    ("codex",  []),
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
    # scrape.py prints the file path as its last (and only) stdout line.
    return result.stdout.strip().splitlines()[-1]


def main():
    paths = []
    for target, passthrough in JOBS:
        paths.append(run_job(target, passthrough))

    print("\nAll dumps:")
    for p in paths:
        print(p)


if __name__ == "__main__":
    main()
