"""Parse the rendered claude /usage panel into structured data.

Strict by design: any divergence from the observed TUI format raises so we
notice when claude updates the panel rather than silently writing stale or
partial data.
"""
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


class ClaudeUsageParseError(Exception):
    """Raised when the /usage panel doesn't match the expected shape."""


PANEL_HEADER = "Settings  Status   Config   Usage   Stats"

REQUIRED_LABELS = {
    "session": "Current session",
    "week": "Current week (all models)",
}
OPTIONAL_LABELS = {
    "sonnet_week": "Current week (Sonnet only)",
}

PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)% used")
RESETS_RE = re.compile(r"\s*Resets (.+?) \(([^)]+)\)\s*$")

SESSION_TIME_RE = re.compile(r"^(\d{1,2})(?::(\d{2}))?(am|pm)$", re.IGNORECASE)
WEEK_TIME_RE = re.compile(
    r"^([A-Za-z]{3}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm)$",
    re.IGNORECASE,
)

MONTHS = {
    m: i
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        start=1,
    )
}


def _to_24h(hour: int, ampm: str) -> int:
    ampm = ampm.lower()
    if ampm == "am":
        return 0 if hour == 12 else hour
    return 12 if hour == 12 else hour + 12


def _resolve_session(raw: str, tz: ZoneInfo, now: datetime) -> datetime:
    m = SESSION_TIME_RE.match(raw.strip())
    if not m:
        raise ClaudeUsageParseError(f"unknown session reset time: {raw!r}")
    hour = _to_24h(int(m.group(1)), m.group(3))
    minute = int(m.group(2) or 0)
    local_now = now.astimezone(tz)
    candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= local_now:
        candidate += timedelta(days=1)
    return candidate


def _resolve_week(raw: str, tz: ZoneInfo, now: datetime) -> datetime:
    m = WEEK_TIME_RE.match(raw.strip())
    if not m:
        raise ClaudeUsageParseError(f"unknown week reset time: {raw!r}")
    mon = m.group(1).title()
    if mon not in MONTHS:
        raise ClaudeUsageParseError(f"unknown month {mon!r} in {raw!r}")
    day = int(m.group(2))
    hour = _to_24h(int(m.group(3)), m.group(5))
    minute = int(m.group(4) or 0)
    local_now = now.astimezone(tz)
    candidate = local_now.replace(
        month=MONTHS[mon], day=day, hour=hour, minute=minute, second=0, microsecond=0
    )
    if candidate <= local_now:
        candidate = candidate.replace(year=candidate.year + 1)
    return candidate


def _find_block(lines: list[str], label: str):
    for i, line in enumerate(lines):
        if line.strip() == label:
            rest = [l for l in lines[i + 1:] if l.strip()]
            if len(rest) < 2:
                raise ClaudeUsageParseError(
                    f"label {label!r} found but missing percent/reset lines"
                )
            return rest[0], rest[1]
    return None


def _parse_block(lines, key, label, *, optional, now, out):
    found = _find_block(lines, label)
    if found is None:
        if optional:
            return
        raise ClaudeUsageParseError(f"required label not found: {label!r}")
    percent_line, reset_line = found

    pm = PERCENT_RE.search(percent_line)
    if not pm:
        raise ClaudeUsageParseError(
            f"label {label!r}: percent line did not match: {percent_line!r}"
        )
    percent = float(pm.group(1))

    rm = RESETS_RE.match(reset_line)
    if not rm:
        raise ClaudeUsageParseError(
            f"label {label!r}: reset line did not match: {reset_line!r}"
        )
    raw_when, tz_name = rm.group(1), rm.group(2)
    try:
        tz = ZoneInfo(tz_name)
    except Exception as exc:
        raise ClaudeUsageParseError(f"unknown timezone {tz_name!r}") from exc

    if key == "session":
        resolved = _resolve_session(raw_when, tz, now)
    else:
        resolved = _resolve_week(raw_when, tz, now)

    out[key] = {
        "percent_used": percent,
        "resets_at": resolved.astimezone().isoformat(),
    }


def parse(text: str, *, now: datetime | None = None) -> dict:
    if PANEL_HEADER not in text:
        raise ClaudeUsageParseError(
            f"panel header not found: {PANEL_HEADER!r} — /usage screen likely changed"
        )

    lines = text.splitlines()
    now = now or datetime.now().astimezone()
    out: dict = {}

    for key, label in REQUIRED_LABELS.items():
        _parse_block(lines, key, label, optional=False, now=now, out=out)
    for key, label in OPTIONAL_LABELS.items():
        _parse_block(lines, key, label, optional=True, now=now, out=out)

    return out
