## Description

**Size:** M
**Files:** system/launchagents/Library/LaunchAgents/arthack.agentuse.daemon.plist, system/buildbot/master.cfg, README.md, scripts/install.sh, tests/test_arthack_claude_pick_auto_profile.py

### Approach

Update the operational artifacts that pin the agentuse name/path: the
daemon's launchd plist, the buildbot CI registration, and prose. These are
FILE edits only — the actual `launchctl bootout`/`bootstrap` with the new
label and the buildbot reload happen in the cutover task `.4`. Rename the
plist Label, WorkingDirectory, and both log paths; rename the plist FILE;
re-point the `~/Library/LaunchAgents` symlink to the renamed file.

### Investigation targets

**Required** (read before coding):
- system/launchagents/Library/LaunchAgents/arthack.agentuse.daemon.plist — Label `arthack.agentuse.daemon`→`arthack.agentusage.daemon`, WorkingDirectory `/Users/mike/code/agentuse`→`.../agentusage`, StandardOut/ErrorPath `~/.local/state/agentuse/server.*`→`.../agentusage/...`. Rename file → `arthack.agentusage.daemon.plist`; re-point `~/Library/LaunchAgents/arthack.agentusage.daemon.plist` symlink.
- system/buildbot/master.cfg:111-112 — `"name": "agentuse"` → `"agentusage"`, `"path": "/Users/mike/code/agentuse"` → `.../agentusage`.
- README.md:56 — registered-repos prose list; scripts/install.sh:626 — prose comment; tests/test_arthack_claude_pick_auto_profile.py:5 — docstring `from agentuse import` → `agentusage`.

### Risks

- The symlink re-point + plist file rename are filesystem ops the worker can stage, but launchctl reload is deferred to `.4` — do NOT bootout/bootstrap here (the new dir/state don't exist yet).
- keeperd + buildbot plists' own WorkingDirectory are NOT agentuse (keeper/arthack) — they reference agentuse only via master.cfg / keeper's default, both handled in `.2`/`.3`.

### Test notes

`plutil -lint` the renamed plist; arthack commit-work runs shellcheck (install.sh) + ruff/pytest (the test docstring change is inert).

## Acceptance

- [ ] Plist Label + WorkingDirectory + both log paths read `agentusage`; file renamed; `~/Library/LaunchAgents` symlink re-pointed and not dangling
- [ ] master.cfg name + path → `agentusage`; README:56 + install.sh:626 + test docstring updated
- [ ] `plutil -lint` passes on the renamed plist; arthack lint matrix green
- [ ] No launchctl reload performed in this task (deferred to .4)

## Done summary
Renamed agentuse to agentusage in arthack ops artifacts: daemon plist (Label/WorkingDirectory/log paths + file rename + re-pointed ~/Library/LaunchAgents symlink), buildbot master.cfg CI registration, README CI list, install.sh comment, and test docstring. No launchctl reload (deferred to .4).
## Evidence
