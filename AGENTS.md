# agentusage

Claude and Codex account ownership, OAuth refresh, observations, balancing,
and a usage TUI. One existing daemon proxies native sessions; Grok retains its
subprocess adapter. `docs/ACCOUNT-OWNERSHIP.md` supersedes the Claude/Codex
ownership sections of `docs/SKETCH.md`; `CONTEXT.md` is the glossary and
`README.md` the operator and launcher contract.

## Commands

- `bun test` — full test suite (no network, no real state dirs; tests use
  temp roots via `AGENTUSAGE_STATE_ROOT`).
- `bun run typecheck` — `tsc --noEmit`.
- `bash scripts/install.sh --install` — the `agentusage` binary (idempotent);
  AgentStart owns the `io.arthack.agentusage.observe` LaunchAgent.

## Conventions

- Bun ≥ 1.3.14, TypeScript run directly — no build step. The public binary is
  a bash shim exec'ing bun against `src/cli.ts`; daemon behavior is the
  `agentusage daemon` subcommand.
- Never import `@opentui/core` at module scope — only `await import(...)`
  inside the TUI entry. The platform-native package top-level-awaits and races
  under parallel `bun test`; TUI-loading tests must stay serial.
- Claude/Codex access uses bounded HTTP against fixed provider origins and the
  owned account pool. Grok remains subprocess JSON (`grok-swap observe --json`).
  Never discover or parse legacy swap stores. Credentials never enter logs,
  argv, result narration, or native homes; launchers transport private prepare
  JSON and renew opaque leases from their existing process.
- Sidecars and policy leaves are written atomically (0600 tmp + rename) under
  `~/.local/state/agentusage/`; leaf reads refuse group/other permission bits
  and symlinks.
- State-mutating paths take the matching `.lock` flock; observation refresh
  locks are non-blocking (contended callers re-read, never stack a second
  provider call).
- All times in sidecars are epoch ms (`*_ms`) or ISO 8601 UTC strings; JSON
  output envelopes carry `schema_version`.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script.
  Skill names and descriptions provide capability discovery; do not add a
  second tool catalog to prompts. See `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
