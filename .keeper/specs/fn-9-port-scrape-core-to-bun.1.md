## Description

**Size:** M
**Files:** package.json, tsconfig.json, biome.json, bun.lock, .gitignore, src/reset-time.ts, src/reset-time.test.ts, CLAUDE.md, README.md

### Approach

Stand up the Bun/TypeScript surface in this repo, styled to keeper conventions: strict-TS ESM tsconfig (`moduleResolution: bundler`, `types: ["bun-types"]`, noEmit), Biome config mirroring keeper's recommended-rules 2-space setup, `package.json` with a compound-word name, a one-line verb-phrase `description` (manifest convention), and `lint`/`typecheck` scripts so keeper commit-work's JS/TS lint seam engages. Add `@js-temporal/polyfill` and write the timezone wrapper module the parsers will consume: named-zone wall-clock construction with explicit `disambiguation: 'compatible'` (Python fold=0), calendar day/year rolls, throw-on-unknown-IANA-zone (Temporal's native RangeError), and two formatters — claude-style (resolve in named zone, reproject to system-local) and codex-style (system-local only) — both emitting seconds-precision offset-bearing ISO with the trailing `[Zone]` bracket stripped and no milliseconds. Write native bun:test unit coverage for the wrapper (new-code coverage, not suite translation). Flip the stale doc invariants to the dual-runtime truth: CLAUDE.md (edit in place — AGENTS.md is a symlink, never rm+recreate) and README.md lose their "Python-only / ships no TypeScript" claims; Python remains described as the authoritative runtime for now.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- ~/code/keeper/tsconfig.json — compiler options to mirror
- ~/code/keeper/biome.json — lint config to mirror
- parse_claude_usage.py:111-207 — the wall-clock resolution semantics the wrapper must reproduce (12h→24h, today/tomorrow roll, this-year/next-year roll, unknown-zone raise)
- parse_codex_status.py:58-99 — system-local-only resolution (NO named zone), date-bearing and date-less suffixes
- tests/test_parse_claude_usage.py:330-418 — the exact resolver assertions (12am/12pm boundaries, rolls, year-wrap) the wrapper's bun:test cases should mirror
- /Users/mike/code/CLAUDE.md — manifest description convention

**Optional** (reference as needed):
- ~/code/keeper/src/usage-flock.ts — db-free-leaf + JSDoc house style
- ~/code/keeper/src/usage-picker.ts — discriminated-union + injectable-seam style

### Risks

- Python aware-datetime arithmetic is wall-clock and fold-aware; a wrapper that does epoch math instead diverges on DST edges. Mirror the resolver test cases exactly in bun:test before the parsers consume the wrapper.
- `datetime.replace(month,day)` raises on invalid dates (Feb 30) where Temporal `with()` may clamp by default — pass `overflow: 'reject'` so both raise.

### Test notes

`bun test src/reset-time.test.ts` covers the wrapper against the mirrored resolver cases; `bun run lint && bun run typecheck` clean; `uv run pytest` untouched and green.

## Acceptance

- [ ] `bun run lint` and `bun run typecheck` exist and pass; `bun test` passes the reset-time unit cases including 12am/12pm boundaries, today/tomorrow and year rolls, unknown-zone throw, and no-milliseconds seconds-precision ISO output in both claude and codex formatter styles
- [ ] package.json carries a one-line verb-phrase description and lint/typecheck scripts
- [ ] CLAUDE.md and README.md no longer claim the repo is Python-only or TypeScript-free; both state Python is currently authoritative
- [ ] `uv run pytest` remains green with zero edits to test files

## Done summary
Stood up the Bun/TS surface (package.json, tsconfig, biome, bun.lock, node_modules gitignore) styled to keeper conventions with lint/typecheck scripts, and ported the claude/codex reset-time resolvers to a Temporal wrapper (src/reset-time.ts) with 22 bun:test cases mirroring the pytest resolver assertions. Flipped CLAUDE.md/README.md Python-only claims to the dual-runtime truth (Python remains authoritative). uv run pytest stays green (117) with zero test edits.
## Evidence
