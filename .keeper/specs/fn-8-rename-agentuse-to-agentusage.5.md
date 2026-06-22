## Description

**Size:** S
**Files:** package.json, src/main.ts, src/cwd-ordinal.ts, src/state-sharing.ts, test/cwd-ordinal.test.ts, test/profile-bootstrap.test.ts, CLAUDE.md, bun.lock

### Approach

Final step, after the cutover renamed the agentuse dir to `agentusage`.
Flip the `file:` dependency + import specifiers, then clear the stale
symlink and reinstall — a plain `bun install` will NOT drop the old
`node_modules/agentuse` symlink, so `rm -rf node_modules` first. agentwrap
(the launcher) is broken between the cutover dir-move and this relink, so
run it immediately after `.4`.

### Investigation targets

**Required** (read before coding):
- package.json:16 `"agentuse": "file:../agentuse"` → `"agentusage": "file:../agentusage"`.
- src/main.ts:18 `from "agentuse"` → `from "agentusage"`; src/cwd-ordinal.ts:24 `from "agentuse/flock"` → `from "agentusage/flock"` (+ comments :6,:9).
- src/state-sharing.ts:677 comment; test/cwd-ordinal.test.ts; test/profile-bootstrap.test.ts; CLAUDE.md (~5 refs).

### Risks

- Skipping `rm -rf node_modules` leaves a dangling `node_modules/agentuse` symlink → `tsc` resolves to a dead path or fails. Always remove node_modules, then `bun install`, then commit the regenerated bun.lock.

### Test notes

Verify end-to-end: `bun pm ls | grep agentusage`; `bun lint` (biome + tsc) green; `bun test`; and the launcher binary actually resolves `agentusage` + `agentusage/flock` and calls `pickProfile`/`listProfiles` (smoke an agentwrap dry pick).

## Acceptance

- [ ] `file:` dep + both import specifiers (incl. `agentusage/flock`) + prose flipped to `agentusage`
- [ ] `rm -rf node_modules && bun install` done; stale `node_modules/agentuse` gone; bun.lock regenerated + committed
- [ ] `bun lint` + `bun test` green; launcher resolves `agentusage` and performs a pick end-to-end

## Done summary

## Evidence
