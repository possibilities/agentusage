## Description

**Size:** M
**Files:** (runtime/filesystem ops, cross-repo) /Users/mike/code/agentuse → agentusage, ~/.local/state/agentuse, ~/.config/agentuse, ~/Library/LaunchAgents

### Approach

The serialized flag-day window. With tasks .1/.2/.3 committed, stop all
launchd jobs (bootout, not kill — KeepAlive respawns), physically move the
repo dir + the two XDG dirs, swap in the renamed plist, and bring the
daemons back up against the new paths. Verify the canary (no stale old
state dir reappears) and that keeper usage flows again. Drive this
SUPERVISED, not unattended — see Risks (this dir-rename moves this epic's
own `.keeper` home).

### Detailed phases

1. **Pre-flight:** re-snapshot PIDs (`launchctl list | grep -E 'agentuse|keeperd|buildbot'`); confirm .1/.2/.3 committed; confirm `~/.local/state/agentuse/picker.json` is the live ledger.
2. **Stop:** `launchctl bootout gui/$(id -u)/arthack.agentuse.daemon`; bootout `arthack.keeperd`; bootout `arthack.buildbot.master`. Confirm all PIDs gone (no respawn).
3. **Move repo dir:** `mv /Users/mike/code/agentuse /Users/mike/code/agentusage` (plain mv — git history rides along in `.git`; NOT `git mv`).
4. **Move state+config together:** `mv ~/.local/state/agentuse ~/.local/state/agentusage` && `mv ~/.config/agentuse ~/.config/agentusage` (same fs, atomic rename; do both before any restart so the daemon never sees new-state/old-config).
5. **Swap plist:** ensure the renamed `arthack.agentusage.daemon.plist` (+ re-pointed symlink from .3) is in `~/Library/LaunchAgents`; remove the stale old symlink if present; `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arthack.agentusage.daemon.plist`.
6. **Restart consumers:** `launchctl bootstrap` keeperd and buildbot.master (their plists' WorkingDirectory unchanged; they now read the renamed path via .2/.3 code).
7. **Verify** (see Acceptance).

### Risks

- **Self-rename hazard:** this epic lives in the agentuse repo's `.keeper`; step 3 moves it to `/Users/mike/code/agentusage/.keeper`, leaving the epic's recorded `primary_repo` stale. keeper resolves epics globally by id, but autopilot path-tracking may drift — drive .4/.5 in a supervised window, not unattended; update `primary_repo` if continuing under autopilot.
- KeepAlive respawn: if any job is `kill`ed instead of `bootout`, it recreates `~/.local/state/agentuse` mid-move and forks the flock inode → silent mutual-exclusion break. Always bootout + confirm PID gone.
- Abort path: if a consumer fails post-move, the rollback is `mv` both dirs + the repo back, restore the old plist/symlink, bootstrap the old labels.

### Rollout

Single supervised window. Rollback = reverse the moves + reload old labels (above). Leave `.keeper` history in all repos untouched throughout.

### Test notes

Canary: after restart, `~/.local/state/agentuse` must NOT reappear; if it does, a job respawned with stale constants — stop and audit.

## Acceptance

- [ ] All three launchd jobs bootout cleanly (PIDs gone, no respawn) before any move
- [ ] Repo dir is `/Users/mike/code/agentusage`; `~/.local/state/agentusage/picker.json` + `~/.config/agentusage/config.yaml` present; old dirs gone
- [ ] agentusage daemon + keeperd + buildbot back up via `launchctl bootstrap`; `launchctl list | grep agentusage.daemon` shows a live PID
- [ ] No stale `~/.local/state/agentuse` reappears (canary); keeper usage projection shows rows again
- [ ] `.keeper` history untouched

## Done summary

## Evidence
