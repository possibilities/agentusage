"""Parse the rendered codex /status panel into structured data.

Strict by design: any divergence from the observed TUI format raises so we
notice when codex updates the panel rather than silently writing stale or
partial data.

Codex displays reset times in the user's local timezone (24h clock, no label),
confirmed by comparing scrape output against the chatgpt.com/codex/settings/usage
web UI. We resolve against the system local timezone at parse time. The optional
Codex-Spark section is emitted as `codex_spark_session` + `codex_spark_week`.
"""
import re
from datetime import datetime, timedelta


class CodexStatusParseError(Exception):
    """Raised when the /status panel doesn't match the expected shape."""


PANEL_SENTINEL = "5h limit:"
SPARK_SENTINEL = "Codex-Spark limit:"

# │  5h limit:   [████] 99% left (resets 14:05)
FIVE_HOUR_RE = re.compile(
    r"5h limit:.*?(\d+)%\s+left\s+\(resets\s+(\d{1,2}):(\d{2})\)"
)
# │  Weekly limit:  [██░░] 29% left (resets 18:28 on 30 May)
WEEKLY_RE = re.compile(
    r"Weekly limit:.*?(\d+)%\s+left\s+\(resets\s+(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]+)\)"
)
MONTHS = {
    m: i
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        start=1,
    )
}


def _resolve_today_time(hour: int, minute: int, now: datetime) -> datetime:
    """Next occurrence of HH:MM in local time — today or tomorrow."""
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def _resolve_date_time(day: int, month_name: str, hour: int, minute: int, now: datetime) -> datetime:
    """Next occurrence of DD Mon HH:MM in local time — this year or next."""
    mon = month_name.title()[:3]
    if mon not in MONTHS:
        raise CodexStatusParseError(f"unknown month {month_name!r}")
    candidate = now.replace(
        month=MONTHS[mon], day=day, hour=hour, minute=minute, second=0, microsecond=0
    )
    if candidate <= now:
        candidate = candidate.replace(year=candidate.year + 1)
    return candidate


def _parse_five_hour(text: str, now: datetime, label: str) -> dict:
    m = FIVE_HOUR_RE.search(text)
    if not m:
        raise CodexStatusParseError(f"{label} 5h limit line not found or didn't match")
    pct_left = int(m.group(1))
    h, mi = int(m.group(2)), int(m.group(3))
    resets_at = _resolve_today_time(h, mi, now)
    return {
        "percent_used": 100 - pct_left,
        "resets_at": resets_at.isoformat(),
    }


def _parse_weekly(text: str, now: datetime, label: str) -> dict:
    m = WEEKLY_RE.search(text)
    if not m:
        raise CodexStatusParseError(f"{label} Weekly limit line not found or didn't match")
    pct_left = int(m.group(1))
    h, mi = int(m.group(2)), int(m.group(3))
    day, month_name = int(m.group(4)), m.group(5)
    resets_at = _resolve_date_time(day, month_name, h, mi, now)
    return {
        "percent_used": 100 - pct_left,
        "resets_at": resets_at.isoformat(),
    }


def parse(text: str, *, now: datetime | None = None) -> dict:
    if PANEL_SENTINEL not in text:
        raise CodexStatusParseError(
            f"panel sentinel {PANEL_SENTINEL!r} not found — /status screen likely changed"
        )

    now = now or datetime.now().astimezone()
    out: dict = {}

    spark_idx = text.find(SPARK_SENTINEL)
    primary_text = text if spark_idx < 0 else text[:spark_idx]
    out["session"] = _parse_five_hour(primary_text, now, "primary")
    out["week"] = _parse_weekly(primary_text, now, "primary")

    if spark_idx >= 0:
        spark_text = text[spark_idx:]
        out["codex_spark_session"] = _parse_five_hour(spark_text, now, "Codex-Spark")
        out["codex_spark_week"] = _parse_weekly(spark_text, now, "Codex-Spark")

    return out
