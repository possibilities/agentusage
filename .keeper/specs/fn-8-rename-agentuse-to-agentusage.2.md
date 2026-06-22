## Description

**Size:** M
**Files:** src/db.ts, src/usage-worker.ts, src/daemon.ts, src/collections.ts, src/reducer.ts, src/epic-deps.ts, cli/usage.ts, test/reducer-lifecycle.test.ts, test/usage.test.ts, test/usage-worker.test.ts, test/transcript-worker.test.ts, test/db.test.ts, test/daemon.test.ts, plugins/prompt/test/oracle/fixtures/render.json, README.md

### Approach

Rename the agentuse state-path strings, internal identifiers, and the
recognized config key to `agentusage` throughout keeper. keeper reads the
on-disk state dir at runtime (it does not import the agentuse package), so
these are self-contained string/identifier edits that land and pass lint
independently. The keeperd REBOOT that makes the new path take effect is
deferred to the cutover task `.4` (keeper resolves the root once at boot).

### Investigation targets

**Required** (read before coding):
- src/db.ts:106 `DEFAULT_AGENTUSE_ROOT = "~/.local/state/agentuse"` → `DEFAULT_AGENTUSAGE_ROOT = "~/.local/state/agentusage"`; :122,168,183,261,270 `agentuseRoot` → `agentusageRoot`; :204 config key `agentuse_root` → `agentusage_root`.
- src/usage-worker.ts:4,99,801 — `~/.local/state/agentuse/` path strings + identifiers + comments (~30 refs, heaviest file).
- src/daemon.ts:2628 flat-leaf-state-dir comment + root handoff; src/collections.ts:264; reducer.ts; epic-deps.ts; cli/usage.ts.
- README.md — ~16 prose refs to `~/.local/state/agentuse/<id>.json` + envelope fields.

### Risks

- The user's live `~/.config/keeper/config.yaml` is NOT repo source — leave it. It has only agentuse-mentioning COMMENTS in the `account_aliases` block, whose keys are account ids (unaffected by the rename). Do not edit the live config.
- `agentuse_root` config key is not set in the user's config (keeper uses the default), so renaming the recognized key is safe — no live migration.

### Test notes

keeper matrix: `bun lint` + `bun test`. The usage-worker / reducer / db tests that join a temp `agentuse` state dir (e.g. usage-worker.test.ts:45) must flip to `agentusage` and stay green.

## Acceptance

- [ ] All `agentuse` path strings + identifiers + the `agentuse_root` key renamed to `agentusage` form across src/, cli/, tests, fixtures, README
- [ ] `grep -rn 'agentuse[^r]' src/ cli/ | grep -v agentusage` is empty
- [ ] `bun lint` + `bun test` green
- [ ] Live `~/.config/keeper/config.yaml` untouched

## Done summary

## Evidence
