## Description

**Size:** S
**Files:** README.md (new), daemon.py (docstring only)

Write the client-facing data-format reference, documenting the FROZEN
envelope contract produced by task .1. Depends on task .1 so the schema in the
README matches exactly what the code emits (docs-gap-scout: write README last).

### Approach

Create `README.md` with proper Markdown headers and fenced JSON blocks
(break from the prose-docstring style — this renders in a browser). Derive
every field from the actual emitted shapes in `daemon.py` after task .1 —
do not invent fields. Cover, at minimum:

- **Purpose + layout**: what the daemon does, where files live
  (`~/.local/state/agentuse/`), the single-daemon constraint (no cross-instance
  lock), and the forward-compat contract ("clients must ignore unknown
  top-level fields"; unknown `schema_version` → skip the file).
- **`<id>.json` envelope**: every field with type, nullability, and one-line
  semantics — `schema_version`, `id`, `target`, `multiplier` (plan-tier weight,
  load-bearing for balancing — document the 1x/5x/20x mapping), `status`,
  `subscription_active`, the three `*_fetch_at` timestamps + `next_fetch_at`
  (ISO 8601 with UTC offset; note `next_fetch_at` is a scheduling hint that may
  be in the past — not a liveness signal), `usage`, `error`.
- **`usage` sub-shapes** as two distinct named shapes (they differ
  structurally): claude = `session` + `week` + optional `sonnet_week`, each
  `{percent_used, resets_at}`; codex = `session` + `week`, each
  `{percent_used, resets_at}`. Show a real JSON example of each.
- **`<id>.error.json`**: `id`, `target`, `multiplier`, `failed_at`,
  `error_type`, `message`, optional `screen_excerpt` — and note it's a debug
  sidecar; clients should read the main envelope's `status`/`error` instead.
- **`events.jsonl`**: the `scraped` (now with `subscription_active`),
  `idle_skipped`, and `scrape_failed` line shapes.
- **Decision matrix**: a `status` × `subscription_active` × `usage`-present
  table mapping to meaning + the client routing rule (skip if
  `subscription_active == false`; distrust `usage` if `status == "stale"`;
  else use `usage`), plus a worked profile-balancing example using
  `multiplier` to weight available accounts.

Then revise the `daemon.py` module docstring: remove the inline envelope-shape
sentence and point at README.md instead (don't duplicate the schema).

### Investigation targets

**Required** (read before writing):
- daemon.py (post task .1) — the actual envelope dicts emitted by every branch
  (success/no-sub/idle/stale) and the `_append_event` call sites; this is the
  authoritative schema source
- parse_claude_usage.py — claude `usage` shape (session/week/sonnet_week)
- parse_codex_status.py — codex `usage` shape (session/week)
- daemon.py:1-13 — current module docstring to revise

### Risks

- README drift: if it claims a key the code doesn't emit on every branch,
  clients break. Cross-check each documented field against the post-task-.1
  emitted shapes.

## Acceptance

- [ ] README.md documents every `<id>.json` field (type, nullability,
  semantics) matching what the code emits
- [ ] claude vs codex `usage` shapes documented separately with JSON examples
- [ ] `<id>.error.json` and all three `events.jsonl` event shapes documented
- [ ] status × subscription_active decision matrix + worked balancing example
  (using `multiplier`) present
- [ ] daemon.py module docstring points at README instead of duplicating schema

## Done summary

## Evidence
