agentuse — scrape Claude/Codex usage per account and expose a round-robin profile picker.

Polyglot repo. The Python daemon (`daemon.py`) is the envelope PRODUCER: it
scrapes each account and writes `~/.local/state/agentuse/<id>.json` envelopes
plus the `picker.json` ledger. The TypeScript library under `src/` is a CONSUMER
surface — `listProfiles()` / `pickProfile()` — that claudewrap imports via
`file:../agentuse`. Both runtimes coexist on the same on-disk state during the
launcher cutover, so the data contract is load-bearing across the language seam.

## Repo facts

- **`AGENTS.md` is a symlink to this file.** Edit in place; never `rm`+recreate.
- **`pyproject.toml` is the authoritative `description`;** `package.json` mirrors
  it verbatim (polyglot-manifest rule). Describe the whole app, not one ecosystem.
- **Forward-facing advice only** in comments and docs: state current behavior and
  invariants, not change history (which lives in the diff).

## Cross-runtime ledger invariants (TS `src/api.ts` ↔ Python `agentuse/api.py`)

- **`schema_version: 1`** on `picker.json`; an unrecognized version is treated as
  absent (start fresh), never migrated. Bump in BOTH runtimes together.
- **Atomic write:** tmpfile in the same dir → write → rename. Serialize as
  `JSON.stringify(state, null, 2) + "\n"` (byte-compatible with Python's
  `json.dump(indent=2)` + trailing newline).
- **Lock:** `flock(LOCK_EX)` on the `picker.json.lock` SIDECAR (not the data
  file, which is replaced by rename), held across the entire read-modify-write-
  rename. Releasing before the rename lets a concurrent pick read stale state.
- **`last_picked_at`** is offset-bearing LOCAL ISO (`...±HH:MM`), matching
  Python's `now().astimezone().isoformat()` — never `toISOString()`'s `Z` form.
  The Python reader treats naive (offset-less) stamps as corrupt.
- **`lift_at` rate-limit:** a future tz-aware instant excludes a profile; an
  offset-less stamp is NOT rate-limited (JS would parse it as local time; Python
  rejects it as corrupt) — require an explicit offset/`Z` before trusting it.
- **State dir** is fixed at `~/.local/state/agentuse` (deliberately NOT
  `XDG_STATE_HOME` — matches Python). Config at `$XDG_CONFIG_HOME`-or-`~/.config`
  `/agentuse/config.yaml`.

## TS conventions

- Bun + bun:ffi; `biome check` + `tsc --noEmit` are the lint matrix (`bun lint`).
- **`bun:ffi` is experimental** — `src/flock.ts` pins two silent macOS-aarch64
  hazards (i32 return width, FD_CLOEXEC-before-flock ordering); keep
  `test/flock.test.ts` as the regression tripwire and pin the bun version.
- **YAML parsing goes through one adapter** (`parseYaml` in `src/api.ts`) so a
  js-yaml swap stays a one-line change. Bun.YAML is YAML 1.2 (no `yes/no/on/off`
  booleans); the config corpus is boolean-free.
- **Clock + state dir are DI seams** (`setClock` / `setStateDir`), never
  `mock.module` (which neither hoists nor auto-resets).
