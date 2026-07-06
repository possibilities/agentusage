"""Record raw child bytes from a REAL scrape to validate synthetic transcripts.

The corpus transcripts are hand-synthesized from captured panel shapes; this
recorder is the reality check. It tees the exact byte stream a real
`claude`/`codex` TUI emits during a live scrape into a file, so a synthetic
`transcript.ansi` can be diffed against ground truth for a scenario reachable on
this box.

Live-only, never part of the offline suite: this file is not named `test_*` so
`uv run pytest` does not collect it, and the one test below is `live`-marked.
Run it opt-in against real binaries:

    uv run pytest tests/record_corpus.py -m live

Or record straight to a file from the shell:

    uv run python tests/record_corpus.py --target claude --profile default \
        --out /tmp/claude-subscribed.raw
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scrape  # noqa: E402

pytestmark = pytest.mark.live


class _RecordingByteStream(scrape.pyte.ByteStream):
    """A pyte ByteStream that also appends every fed chunk to a shared sink."""

    sink: bytearray = bytearray()

    def feed(self, data: bytes) -> None:
        type(self).sink += data
        super().feed(data)


def record(
    target: str,
    *,
    profile: str = "default",
    command: str | None = None,
    out: Path | None = None,
) -> tuple[bytes, str]:
    """Run a real scrape, teeing raw child bytes. Returns (raw_bytes, rendered).

    Optionally writes the raw byte stream to `out`. Uses the same passthrough
    translation the CLI applies so a named claude profile is honored.
    """
    passthrough: list[str] = []
    if target == "claude" and profile != "default":
        passthrough = ["--agentwrap-profile", profile]

    original = scrape.pyte.ByteStream
    _RecordingByteStream.sink = bytearray()
    setattr(scrape.pyte, "ByteStream", _RecordingByteStream)
    try:
        rendered = scrape.scrape(target, passthrough, command=command)
    finally:
        setattr(scrape.pyte, "ByteStream", original)

    raw = bytes(_RecordingByteStream.sink)
    if out is not None:
        out.write_bytes(raw)
    return raw, rendered


def test_record_claude_captures_panel_evidence(tmp_path: Path) -> None:
    """Live: a real claude scrape emits bytes that render the /usage panel.

    Skips gracefully when the real binary is not reachable so the live sweep
    stays green on a box without a signed-in default profile.
    """
    default_command = scrape.TARGETS["claude"]["command"]
    if not isinstance(default_command, str) or not Path(default_command).exists():
        pytest.skip("claude binary not present on this box")

    raw, rendered = record("claude", out=tmp_path / "claude-default.raw")
    assert raw, "recorded no raw bytes from the live scrape"
    # Any of the panel arms proves the TUI drove a real screen, not an empty PTY.
    assert any(
        marker in rendered
        for marker in ("Current week (all models)", "% of usage", "Paste code here")
    ), "live scrape rendered no recognizable /usage panel arm"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="record_corpus")
    ap.add_argument("--target", required=True, choices=["claude", "codex"])
    ap.add_argument("--profile", default="default")
    ap.add_argument("--command", default=None)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    raw, rendered = record(
        args.target, profile=args.profile, command=args.command, out=args.out
    )
    sys.stderr.write(f"recorded {len(raw)} raw bytes to {args.out}\n")
    sys.stderr.write(rendered + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
