"""Parse the rendered claude /usage panel into structured data.

Strict by design: any divergence from the observed TUI format raises so we
notice when claude updates the panel rather than silently writing stale or
partial data.

Two-axis result contract:

- Subscribed accounts render rate-limit bars (``"% used"``) and parse into a
  ``{session, week[, sonnet_week]}`` dict.
- No-subscription accounts render a usage-contribution breakdown
  (``"% of usage"``, ``"What's contributing to your limits usage?"``) with no
  bars; we raise :class:`NoActiveSubscription` so the caller treats this as a
  successful read with ``usage=None`` / ``subscription_active=False`` rather
  than as a parse failure.
- Anything else (panel never rendered, real format drift) raises
  :class:`ClaudeUsageParseError`.

Precedence inside :func:`parse`: subscribed-bars > no-sub-breakdown > error.
"""

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


class ClaudeUsageParseError(Exception):
    """Raised when the /usage panel doesn't match the expected shape."""


class NoActiveSubscription(Exception):
    """Raised when the /usage panel rendered but the account has no plan limits.

    The panel shows the usage-contribution breakdown (no rate-limit bars).
    Callers should treat this as a successful read of "no subscription" rather
    than a parse failure: there is nothing to parse and nothing wrong.
    """


PANEL_HEADER = "Settings  Status   Config   Usage   Stats"

# Shared sentinel for the no-subscription usage-contribution breakdown.
# Used both here (to distinguish no-sub from real format drift) AND in
# scrape.py's appear-sentinel retry loop to short-circuit the ~180s wait.
# The two paths MUST key on the same literal — if you change this, change
# scrape.TARGETS["claude"]["appear_nosub"] in lockstep.
NO_SUB_SENTINEL = "% of usage"

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
        [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ],
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
            rest = [ln for ln in lines[i + 1 :] if ln.strip()]
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


def derive_lift_at(usage: dict | None) -> str | None:
    """Return the binding rate-limit lift time for a parsed `usage` dict.

    The lift is the soonest `resets_at` among windows whose `percent_used`
    has hit or exceeded 100% — the wall-clock instant at which the binding
    limit will release. Windows below 100% are never binding even if they
    reset sooner.

    Returns `None` when:
    - `usage` is `None` (no successful subscribed scrape yet / no-sub),
    - no window is at >=100%,
    - or every >=100% window is missing `resets_at` (defensive; the parser
      always emits both fields together, so this is a belt-and-suspenders
      guard).

    Pure: takes the already-parsed window dict and inspects its values; no
    clock reads, no I/O. Tests can pass canned dicts directly.
    """
    if not usage:
        return None
    soonest: str | None = None
    for window in usage.values():
        if not isinstance(window, dict):
            continue
        percent = window.get("percent_used")
        resets_at = window.get("resets_at")
        if percent is None or resets_at is None:
            continue
        if percent < 100:
            continue
        if soonest is None or resets_at < soonest:
            soonest = resets_at
    return soonest


def parse(text: str, *, now: datetime | None = None) -> dict:
    # Bars are the positive signal for a subscribed account: the rate-limit
    # rows render "<pct>% used", a literal the no-sub breakdown never emits
    # (it uses "% of usage"). Branching on bar presence — not on the panel
    # header — keeps the subscribed and no-sub paths fully disjoint.
    has_bars = PERCENT_RE.search(text) is not None

    if has_bars:
        # Relax the header gate to case-insensitive on the bars path: the
        # tab strip casing varies between scrapes ("Usage" vs "usage") and
        # we don't want a cosmetic flip to spuriously raise on a panel that
        # otherwise has all the bars present.
        if PANEL_HEADER.lower() not in text.lower():
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

    # No bars — either no subscription (panel opened, breakdown rendered) or
    # the panel genuinely never rendered (real failure / format drift).
    if NO_SUB_SENTINEL in text:
        raise NoActiveSubscription(
            "claude /usage panel rendered the usage-contribution breakdown "
            "with no rate-limit bars — account has no active subscription"
        )

    raise ClaudeUsageParseError(
        "no rate-limit bars and no no-subscription breakdown found — "
        "/usage panel did not render or its format changed"
    )
