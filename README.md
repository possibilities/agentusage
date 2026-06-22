# agentusage

A long-lived daemon that scrapes Claude `/usage` and Codex `/status` panels
once per account on a `uniform(60, 180)s` jitter, then writes a self-stamped
JSON envelope per account that an external client (a profile balancer) reads
to route work to accounts with available quota.

This document is the **client-facing data-format reference**. If you're a
client developer reading these files, this is the contract you depend on.

## Layout

All state lives under `~/.local/state/agentusage/`:

- `<id>.json` — the main per-account envelope. One file per account. Atomic
  same-filesystem rename writes; readers see either the previous full file
  or the new full file, never a partial.
- `<id>.error.json` — debug sidecar written only on a failed scrape (verbose,
  may include a screen excerpt). Removed on the next successful scrape.
  **Clients should not poll this file** — read the main envelope's `status`
  and `error` fields instead.
- `events.jsonl` — append-only audit log of every scrape attempt, idle-skip,
  and failure across all accounts. One JSON object per line. Unbounded; no
  rotation today.

There is no cross-instance lock. Two daemons would race the same state files.
Run one at a time.

## TypeScript API

The agentusage package (this repo) exposes a small reader so an external launcher
(arthack's agentwrap) can answer one question without spinning up the daemon:
**"which Claude profile should I use right now?"** Import it from `src/` (the
package `exports` map points `.` at `src/index.ts`):

```ts
import { pickProfile, listProfiles } from "agentusage";

const profile = pickProfile();   // weighted balance over subscribed claude accounts
const names = listProfiles();    // configured profile names from config.yaml
```

- `pickProfile(): string` — credit-weighted balance over eligible accounts
  (envelope `target === "claude"` and `subscription_active === true`). Each
  profile's `effective_weight = multiplier × session_headroom`, where
  `session_headroom = clamp(1 − usage.session.percent_used/100, 0, 1)`; the
  pick minimizes `count / weight` (stride scheduling), ties break by name. So
  a Max-5x account draws ~5× the picks of a Pro at equal headroom, and a
  profile burning its session window sheds load automatically. The pick is
  stamped to `~/.local/state/agentusage/picker.json` under an `flock` (the
  `FileLock` helper exported from `agentusage/flock`), so concurrent launches
  can't both draw the same profile. Session window only (v1 scope); no stale
  filter — `status === "stale"` still rotates on its last-good headroom.
- `listProfiles(): string[]` — the `profiles:` list from
  `~/.config/agentusage/config.yaml` (or `$XDG_CONFIG_HOME/agentusage/config.yaml`),
  filtered to non-empty strings.
- **Fail-open.** Any failure (no eligible profile, unreadable state, lock
  trouble, corrupt JSON, missing config) returns `"default"` from
  `pickProfile` or `[]` from `listProfiles`. Neither function ever throws;
  a broken picker must never block a launch. `"default"` is itself a real
  account id, so the fallback and a legitimate pick are the same string.

The daemon (`daemon.py`, `scrape.py`, `parse_*.py`) stays flat at the repo
root and runs in-place via `uv run python daemon.py` — it is the *producer*
of the envelopes the reader consumes.

## Development

The project pins Python **3.11** (`.python-version`); `uv sync` rebuilds the
venv against it. Run the test suite with `uv run pytest` — it's fast and
fully offline (no real TUI, no network). Tests that spawn a real claude/codex
TUI are tagged with the `live` marker and excluded by default; run them
opt-in with `uv run pytest -m live`.

## Forward-compatibility contract

- **Clients MUST ignore unknown top-level fields** in any envelope or event.
  New fields may be added in a minor revision without bumping
  `schema_version`.
- **Clients SHOULD skip a file whose `schema_version` they don't recognize.**
  When the daemon bumps the version the on-disk shape has changed in a way
  the client wasn't built for.
- The current version is `schema_version: 1`.

## `<id>.json` — main envelope

Every variant (active success, no-subscription success, idle skip, stale
failure) carries the **same top-level key set** with `null` where a field
doesn't apply. A client never has to branch on key presence — only on
values.

| Field | Type | Nullable | Semantics |
|---|---|---|---|
| `schema_version` | int | no | Envelope schema version. `1` today. Skip files with an unrecognized version. |
| `id` | string | no | Account id (`default`, `multi-claude-1`, `codex`, ...). Matches the filename stem. |
| `target` | string | no | `"claude"` or `"codex"` — which TUI was scraped. |
| `multiplier` | int | no | Plan-tier weight for profile balancing. **Load-bearing.** See [Multiplier](#multiplier) below. |
| `status` | string | no | `"active"` \| `"idle"` \| `"stale"`. Freshness/liveness axis. See [Status](#status). |
| `subscription_active` | bool \| null | yes | Plan axis. `true` = subscribed (has rate-limit bars), `false` = confirmed no subscription, `null` = unknown (codex; never observed yet). |
| `last_successful_fetch_at` | string \| null | yes | ISO 8601 timestamp with UTC offset of the most recent successful scrape. `null` until the first success. |
| `last_skipped_fetch_at` | string \| null | yes | ISO 8601 timestamp with UTC offset of the most recent idle-skip. `null` if never skipped. |
| `last_failed_fetch_at` | string \| null | yes | ISO 8601 timestamp with UTC offset of the most recent failure. `null` if never failed. |
| `next_fetch_at` | string | no | ISO 8601 timestamp with UTC offset — the daemon's intended next attempt. **Scheduling hint only.** It is normal for this to be in the past (the daemon was paused, the scrape is in flight, the lock is held). Do not treat this as a liveness signal. |
| `usage` | object \| null | yes | Parsed quota data. Shape depends on `target` — see [`usage` shapes](#usage-shapes). `null` when no successful scrape has populated it yet, or when `subscription_active == false`. |
| `lift_at` | string \| null | yes | ISO 8601 timestamp with UTC offset — the wall-clock instant a rate-limited profile becomes eligible again. Computed as the soonest `resets_at` among `usage` windows whose `percent_used >= 100`. `null` when no window is over its limit (or when `usage` is `null`). Carried forward through `idle` and `stale` writes the same way `usage` is preserved, so a paused/failed scrape doesn't drop a still-valid lift mid-cooldown. Recomputed fresh on every successful scrape (never carried forward across a success), so a window dropping below 100% clears the lift. |
| `error` | object \| null | yes | Concise error stamp present only when `status == "stale"`. `null` otherwise. See [Stale `error`](#stale-error). |

### Multiplier

The plan-tier weight a balancer uses to size each account's slice of the
available quota pool. Higher is more headroom.

| Tier (source: `.claude.json` `oauthAccount.organizationRateLimitTier`) | `multiplier` |
|---|---|
| `default_claude_ai` (Pro) | `1` |
| `default_claude_max_5x` (Max 5x) | `5` |
| `default_claude_max_20x` (Max 20x) | `20` |
| Codex (no tier concept) | `1` |
| Any read failure, missing tier, or unknown tier | `1` (fallback, logged) |

The daemon re-resolves `multiplier` from the profile's `.claude.json` at the
top of every fetch cycle, so a mid-run tier change (upgrade or downgrade)
reaches the envelope within one cycle — no restart needed. A transient
read/parse failure keeps the prior multiplier rather than flickering to 1x
(the boot-time 1x fallback in the table above still applies, since at boot
there is no prior value to keep).

### Status

The freshness/liveness axis. Stamped at write time, not derived by the reader.

- `"active"` — the most recent attempt was a successful scrape; `usage`
  reflects what the TUI rendered.
- `"idle"` — the daemon skipped this cycle because no claude/codex session
  log has been touched in >15 minutes; no quota burn since the last scrape,
  so the prior `usage` is preserved and still considered current. **Never
  overwrites a `stale` status** — a failing account keeps retrying through
  quiet periods.
- `"stale"` — the most recent attempt failed. `usage` and
  `subscription_active` are the **last-good values from the previous
  successful scrape**, preserved through the failure. They may be hours old.
  `error` carries a concise type/message/at stamp.

## `usage` shapes

The `usage` shape depends on `target`. Claude and Codex differ structurally
— they aren't unifiable into a single shape today. A client must switch on
`target` (or check key presence) before reading.

All `percent_used` values are floats in `[0, 100]`. All `resets_at` values
are ISO 8601 timestamps with UTC offset, resolved to absolute wall-clock
times by the daemon at parse time.

### claude `usage`

```json
{
  "session": {
    "percent_used": 38.0,
    "resets_at": "2026-05-29T15:00:00-07:00"
  },
  "week": {
    "percent_used": 12.5,
    "resets_at": "2026-06-02T09:00:00-07:00"
  },
  "sonnet_week": {
    "percent_used": 4.0,
    "resets_at": "2026-06-02T09:00:00-07:00"
  }
}
```

- `session` and `week` are always present on a subscribed-claude success.
- `sonnet_week` is **optional** — only present when the TUI renders the
  `Current week (Sonnet only)` row. Don't assume it's there.

### codex `usage`

```json
{
  "session": {
    "percent_used": 1,
    "resets_at": "2026-05-29T14:05:00-07:00"
  },
  "week": {
    "percent_used": 71,
    "resets_at": "2026-05-30T18:28:00-07:00"
  }
}
```

- `session` (5h limit) and `week` (weekly limit) are both always present on a
  codex success.
- No `sonnet_week`. Codex has no per-model breakdown.
- Codex `percent_used` is an integer (the TUI shows whole percentages); claude
  may include a single decimal.

## `<id>.error.json` — debug sidecar

Written on every failed scrape, removed on the next success. **Clients
should read the main `<id>.json`'s `status` and `error` instead** — this
file exists for human debugging when format drift or a wedged TUI breaks a
scrape.

```json
{
  "id": "multi-claude-2",
  "target": "claude",
  "multiplier": 5,
  "failed_at": "2026-05-29T11:42:17-07:00",
  "error_type": "ClaudeUsageParseError",
  "message": "required label not found: 'Current session'",
  "screen_excerpt": [
    "Settings  Status   Config   usage   Stats",
    "...",
    "(up to 24 compact nonblank lines, head + tail)"
  ]
}
```

| Field | Type | Nullable | Semantics |
|---|---|---|---|
| `id` | string | no | Same id as the main envelope. |
| `target` | string | no | `"claude"` or `"codex"`. |
| `multiplier` | int | no | Tier multiplier at the time of failure. |
| `failed_at` | string | no | ISO 8601 timestamp with UTC offset. |
| `error_type` | string | no | Python exception class name (`ClaudeUsageParseError`, `TimeoutError`, etc.). |
| `message` | string | no | Exception message. |
| `screen_excerpt` | list[string] | optional | Up to 24 compact nonblank rendered screen lines (head + tail with omission marker). Present only when a rendered screen was captured before the failure. |

## Stale `error`

The concise error object in the **main envelope** when `status == "stale"`.
Does **not** include `screen_excerpt` — the main file stays small and
machine-readable.

```json
{
  "type": "ClaudeUsageParseError",
  "message": "required label not found: 'Current session'",
  "at": "2026-05-29T11:42:17-07:00"
}
```

## `events.jsonl` — audit log

One JSON object per line. Append-only. Three event shapes.

### `scraped`

```json
{
  "ts": "2026-05-29T11:42:17-07:00",
  "id": "default",
  "target": "claude",
  "event": "scraped",
  "next_fetch_at": "2026-05-29T11:44:38-07:00",
  "usage": { "session": { "percent_used": 38.0, "resets_at": "..." }, "week": { "percent_used": 12.5, "resets_at": "..." } },
  "subscription_active": true
}
```

- Emitted on every successful scrape (including no-subscription successes,
  where `usage` is `null` and `subscription_active` is `false`).
- `subscription_active` is `null` for codex (no plan concept).

### `idle_skipped`

```json
{
  "ts": "2026-05-29T11:42:17-07:00",
  "id": "default",
  "target": "claude",
  "event": "idle_skipped",
  "idle_for_s": 1834.2,
  "next_fetch_at": "2026-05-29T11:44:38-07:00"
}
```

Emitted when the daemon skipped a scrape because no session log was touched
within the idle window (15 min). The main envelope is also refreshed with
`status: "idle"` and a bumped `next_fetch_at`.

### `scrape_failed`

```json
{
  "ts": "2026-05-29T11:42:17-07:00",
  "id": "multi-claude-2",
  "target": "claude",
  "event": "scrape_failed",
  "error_type": "ClaudeUsageParseError",
  "message": "required label not found: 'Current session'",
  "consecutive_failures": 2,
  "screen_excerpt": ["Settings  Status   Config   usage   Stats", "..."]
}
```

- `consecutive_failures` increments per account and resets on the next
  success.
- `screen_excerpt` is included only when one was captured.

## Decision matrix

The two axes (`status` × `subscription_active`) cover every observed
combination. The full matrix is:

| `status` | `subscription_active` | `usage` present? | Meaning | Client routing |
|---|---|---|---|---|
| `active` | `true` | yes | Subscribed account, fresh data | **Use `usage`.** Eligible for balancing. |
| `active` | `false` | no (`null`) | Confirmed no plan; the panel rendered the no-sub breakdown | **Skip.** No quota to balance against. |
| `active` | `null` | yes | Codex success (no plan concept) | **Use `usage`.** Eligible for balancing. |
| `idle` | `true` | yes (preserved last-good) | Subscribed; daemon paused on inactivity, quota hasn't burned | **Use `usage`.** Eligible — the data is still current. |
| `idle` | `false` | no (`null`) | Confirmed no-sub; daemon paused on inactivity | **Skip.** Same as `active` + `false`. |
| `idle` | `null` | yes (preserved last-good) | Codex; daemon paused on inactivity | **Use `usage`.** Same as `active` + `null`. |
| `stale` | `true` | yes (last-good, may be hours old) | Last attempt failed; `usage` is the previous success | **Distrust `usage`.** Either skip, or treat as low-confidence. Check `error.at` for how stale. |
| `stale` | `false` | no (`null`) | Last attempt failed; previously confirmed no-sub | **Skip.** Same as `active` + `false`. |
| `stale` | `null` | yes \| no | Last attempt failed; codex, or first-ever attempt failed | **Distrust `usage`.** Same as `stale` + `true`. |

### Routing rule (short form)

1. **If `subscription_active == false`: skip.** No quota to weigh.
2. **Else if `status == "stale"`: distrust `usage`.** Either skip or downweight
   based on how recent `error.at` is.
3. **Else: use `usage`.** Weight by `multiplier × session headroom` against the
   configured pool, where session headroom = `1 − usage.session.percent_used/100`.

### Worked balancing example

Three accounts available right now:

```json
{ "id": "default",         "target": "claude", "multiplier": 1,  "status": "active", "subscription_active": true,  "usage": {"session": {"percent_used": 30.0}, "week": {"percent_used": 10.0}} }
{ "id": "multi-claude-2",  "target": "claude", "multiplier": 5,  "status": "active", "subscription_active": true,  "usage": {"session": {"percent_used": 60.0}, "week": {"percent_used": 25.0}} }
{ "id": "multi-claude-3",  "target": "claude", "multiplier": 20, "status": "active", "subscription_active": true,  "usage": {"session": {"percent_used": 80.0}, "week": {"percent_used": 40.0}} }
{ "id": "multi-claude-1",  "target": "claude", "multiplier": 1,  "status": "active", "subscription_active": false, "usage": null }
{ "id": "multi-claude-4",  "target": "claude", "multiplier": 5,  "status": "stale",  "subscription_active": true,  "usage": {"session": {"percent_used": 50.0}, "week": {"percent_used": 22.0}}, "error": {"type": "TimeoutError", "message": "...", "at": "2026-05-29T11:30:00-07:00"} }
```

Applying the routing rule:

- `multi-claude-1`: `subscription_active == false` → **skip**.
- `multi-claude-4`: `status == "stale"` → **skip** (or downweight; here we skip).
- The other three are eligible.

Compute remaining-quota weight as `multiplier * (1 - session.percent_used/100)`
(session window only — quota-left is the binding constraint and the feedback
loop self-corrects as a window fills):

| id | multiplier | session % used | weight | normalized |
|---|---|---|---|---|
| `default` | 1 | 30% | `1 * 0.70 = 0.70` | 10.4% |
| `multi-claude-2` | 5 | 60% | `5 * 0.40 = 2.00` | 29.9% |
| `multi-claude-3` | 20 | 80% | `20 * 0.20 = 4.00` | 59.7% |

Route 60% of new work to `multi-claude-3` (the Max 20x absorbs the largest
share even though it's the most-used), 30% to `multi-claude-2`, 10% to
`default`. The `multiplier` is what keeps the Pro account from being
disproportionately preferred just because it shows a lower `percent_used`
— small accounts have less absolute room.
