agentusage — one-shot Claude/Codex usage scrape util. Scrapes a single account's
`/usage` (Claude) or `/status` (Codex) panel and prints a discriminated JSON
contract; writes no state.

Python-only repo. The entry point is `agentusage.scrape_cli` — a stateless
ONE-SHOT util: keeper's `usage-scraper-worker` shells out to it once per account
(`uv run --project ~/code/agentusage python -m agentusage.scrape_cli …`), and the
worker owns all orchestration (scheduling, idle/cooldown gating, tier/multiplier
resolution, envelope assembly) plus the `~/.local/state/agentusage/<id>.json`
envelope writes. The credit-weighted profile picker that reads those envelopes is
vendored into keeper (`src/usage-picker.ts` + `src/usage-flock.ts`); this repo no
longer ships TypeScript and keeper no longer resolves `file:../agentusage`.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **`pyproject.toml` is the sole authoritative manifest** (Python-only repo). Its
  one-line `description` describes the whole app. Keep it in sync if the app's
  purpose shifts.
- **Forward-facing advice only** in comments and docs: state current behavior and
  invariants, not change history (which lives in the diff).

## Envelope/ledger on-disk contract (the language seam to keeper)

The envelopes this util feeds and the `picker.json` ledger the in-keeper picker
reads are the load-bearing cross-runtime contract. Both halves must agree:

- **`schema_version: 1`** on `picker.json`; an unrecognized version is treated as
  absent (start fresh), never migrated. Bump in BOTH runtimes together.
- **Atomic write:** tmpfile in the same dir → write → rename. Python serializes as
  `json.dump(indent=2)` + trailing newline (byte-compatible with the keeper
  picker's `JSON.stringify(state, null, 2) + "\n"`).
- **Lock:** `flock(LOCK_EX)` on the `picker.json.lock` SIDECAR (not the data
  file, which is replaced by rename), held across the entire read-modify-write-
  rename. Releasing before the rename lets a concurrent pick read stale state.
- **`last_picked_at`** is offset-bearing LOCAL ISO (`...±HH:MM`) from
  `now().astimezone().isoformat()` — never a `Z`/UTC form. A naive (offset-less)
  stamp is treated as corrupt.
- **`lift_at` rate-limit:** a future tz-aware instant excludes a profile; an
  offset-less stamp is NOT rate-limited — require an explicit offset/`Z` before
  trusting it.
- **State dir** is fixed at `~/.local/state/agentusage` (deliberately NOT
  `XDG_STATE_HOME`). Config at `$XDG_CONFIG_HOME`-or-`~/.config`
  `/agentusage/config.yaml`.

## Python conventions

- Pins Python **3.11** (`.python-version`); `uv sync` rebuilds the venv. Run the
  suite with `uv run pytest` — fast and fully offline (no real TUI, no network).
  Tests that spawn a real `claude`/`codex` TUI carry the `live` marker and are
  excluded by default; run them opt-in with `uv run pytest -m live`.
- The scrape mechanics (`scrape.py`, `parse_claude_usage.py`,
  `parse_codex_status.py`) stay flat at the repo root; `agentusage/scrape_cli.py`
  wraps them as the one-shot util.
