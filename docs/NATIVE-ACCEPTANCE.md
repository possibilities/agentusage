# Native account transport acceptance

The regular tests use fake harness executables and no network. This optional
acceptance uses stock Codex and Claude with fake accounts, temporary native
homes and local mock upstreams. It does not enroll or change production
accounts. Use the candidate checkouts together before the coordinated cutover:

```sh
AGENTUSAGE_ACCEPTANCE_AGENTLAUNCH=/path/to/agentlaunch \
  AGENTUSAGE_ACCEPTANCE_CODEX=/path/to/native/codex \
  AGENTUSAGE_ACCEPTANCE_CLAUDE=/path/to/native/claude \
  bun scripts/native-acceptance.ts
```

The binary overrides are optional; otherwise PATH resolves them. The script
sets the launcher recursion sentinel, disables native telemetry/nonessential
traffic, installs inert local resource fixtures, traps OpenAI fallback at
loopback port 9, and stops every mock listener and child before removing its
root. It fails on nonzero exit, leaked leases, lost native history or missing
quota reassignment. No installer runs.

Coverage includes Codex exec pinned by native account ID, with a native profile, managed skill/MCP resources
and user `-c` settings; nested exec resume into the same thread; automatic quota
rejection and reassignment; and Claude launch/resume in a shared native home.
The temporary Codex home also contains a fake native ChatGPT login. A stock
app-server control probe must see it, while the AgentUsage provider must report
`account:null` and `requiresOpenaiAuth:false`; this proves managed sessions do
not inherit native account-limit or model-fallback behavior. An explicit Astra
launch must reach the proxy as Astra, and no managed request may switch to Luna.
Transport overrides follow all native/resource options and precede literal
`--`. Codex 0.153.4 requires named profiles as `<name>.config.toml` within the
native home. The old `[profiles.name]` format is rejected by that release.

For interactive acceptance append `--interactive-window`. After noninteractive
checks the script prints the path of a private `interactive.json` containing
`env`, `id`, `root` and `launchRoot`. Run candidate AgentLaunch under a named
Terminal Control session using that exact environment and root:

```text
bun <launchRoot>/src/main.ts x-resume <id> --x-harness codex --x-no-yolo
  -p proof -c mcp_servers.shadcn.enabled=false
```

Verify the TUI restores the earlier user and assistant messages, submit
`Say interactive proof` (paste and Enter may require separate input steps),
and verify `interactive accepted`. Exit and stop the named session, then touch
`<root>/interactive-done` to finish the fixture. The window self-expires after
180 seconds; the named terminal must still be stopped explicitly.

Recorded 2026-09-07: stock Codex 0.153.4 and installed Claude completed all
noninteractive checks; the Codex interactive TUI restored history and answered
`interactive accepted`. All leases were released and temporary listeners and
sessions were stopped. Live Claude subscription acceptance remains unavailable
on the inactive subscription; mock native transport acceptance is separate
from production onboarding and subscription access.
