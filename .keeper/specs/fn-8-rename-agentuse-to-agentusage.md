## Overview

Rename the project `agentuse` → `agentusage` across four independent git
repos (agentuse, agentwrap, keeper, arthack), the live XDG state/config it
owns on disk, AND the agentuse GitHub remote, executed as a sequenced
flag-day cutover. The producer is a launchd-managed Python daemon writing
`~/.local/state/agentuse/<id>.json` envelopes + a `picker.json` ledger;
consumers are the agentwrap launcher (imports the TS lib via
`file:../agentuse`) and a keeper daemon that watches the same state dir live.
This is a directory/name rename only — the JSON schema is unchanged
(`schema_version` stays 1; no migration, no cross-runtime bump). End state:
every reference, path, package name, import specifier, launchd plist, CI
registration, the on-disk state/config dirs, and the git remote read
`agentusage`, with all three daemons running clean against the new paths.

## Quick commands

- `launchctl list | grep -E 'agentusage|keeperd|buildbot'` — all three jobs up, agentusage daemon alive
- `test -f ~/.local/state/agentusage/picker.json && ! test -e ~/.local/state/agentuse && echo OK` — state moved, no stale old dir respawned (the canary)
- `cd /Users/mike/code/agentwrap && bun pm ls 2>/dev/null | grep agentusage` — launcher resolves the renamed dep
- `git -C /Users/mike/code/agentusage remote -v | grep agentusage` — remote renamed + local origin updated
- `cd /Users/mike/code/keeper && grep -rn 'agentuse[^r]' src/ | grep -v agentusage` — no stale keeper refs (expect empty)

## Acceptance

- [ ] Zero live (non-`.keeper`) references to `agentuse` remain across all four repos (string `agentusage` excepted)
- [ ] `~/.local/state/agentusage/` and `~/.config/agentusage/` exist with the moved ledger + profile list; old dirs gone and not recreated
- [ ] All three launchd jobs run against the new paths; agentuse daemon writes `~/.local/state/agentusage`
- [ ] keeper usage projection shows rows again after keeperd reboot; agentwrap launcher resolves `agentusage` + `agentusage/flock`
- [ ] GitHub repo renamed to `possibilities/agentusage`; local `origin` set-url updated
- [ ] `.keeper` plan history left untouched in every repo

## Early proof point

Task that proves the approach: `.1` (agentuse in-repo rename). It exercises
the load-bearing pattern — flipping hand-inlined leaf strings in both
runtimes, the two coupled pairs, and regenerating (not hand-editing) the
lockfiles — and must pass `bun lint`+`bun test`+`ruff`+`pytest` in place
while the dir is still named `agentuse`. If it fails: the leaf-string or
lockfile-regen approach is wrong and the cutover assumptions need revisiting
before any on-disk move.

## References

- Daemons are launchd KeepAlive jobs (`arthack.agentuse.daemon` PID-snapshot 73072, `arthack.keeperd` 32702, `arthack.buildbot.master` 10929) symlinked from `arthack/system/launchagents/Library/LaunchAgents/` → `~/Library/LaunchAgents/`. Stop = `launchctl bootout`, NOT `kill` (KeepAlive respawns and recreates the old state dir).
- flock locks bind to the inode/open-file-description, not the path: the daemon MUST be fully down before `mv`, else a post-move open of the new path gets a separate unlocked inode and mutual exclusion silently breaks (flock(2)).
- keeper resolves the watch root ONCE at boot (`db.ts:341 resolveUsageRoot` → `daemon.ts:2639 workerData.root`); it never re-reads, so keeperd must be rebooted after the move.
- bun `file:` deps install under the target package's `name`; renaming the dir leaves a stale `node_modules/agentuse` symlink — the consumer needs `rm -rf node_modules && bun install`, not a plain install.
- Remote is `https://github.com/possibilities/agentuse.git`; GitHub auto-redirects a renamed repo, and no manifest/README/other-repo hardcodes the URL, so the remote rename is low-risk and self-contained.

## Docs gaps

- **agentuse/README.md + CLAUDE.md (AGENTS.md symlink)**: update XDG paths, package name, import examples to `agentusage`; forward-facing only, no "renamed from" narration.
- **keeper/README.md**: ~16 prose refs to the agentuse state path / envelope fields — update to `agentusage`.
