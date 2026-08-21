# agentusage

Claude + Codex account usage observations, balancing, and a usage TUI, built
on claude-swap (`cswap`, Python/uv) and codex-swap (Node) as the durable
per-provider stores. Rebuild of keeper's `usage` subsystem for this account;
`docs/SKETCH.md` is the build contract, `CONTEXT.md` the glossary, `README.md`
the operator and launcher-integration guide.

## Commands

- `bun test` — full test suite (no network, no real state dirs; tests use
  temp roots via `AGENTUSAGE_STATE_ROOT`).
- `bun run typecheck` — `tsc --noEmit`.
- `bash scripts/install.sh --install` — the `agentusage` binary (idempotent);
  AgentStart owns the `agentusage.observer` LaunchAgent.
- `bash scripts/install-providers.sh` — best-effort cswap + codex-swap
  provisioning.

## Conventions

- Bun ≥ 1.3.14, TypeScript run directly — no build step. The public binary is
  a bash shim exec'ing bun against `src/cli.ts`; daemon behavior is the
  `agentusage daemon` subcommand.
- Never import `@opentui/core` at module scope — only `await import(...)`
  inside the TUI entry. The platform-native package top-level-awaits and races
  under parallel `bun test`; TUI-loading tests must stay serial.
- Provider access is subprocess JSON (`cswap list --json`,
  `codex-swap snapshot --json`), bounded (timeout, output cap), no-shell
  spawn. Never parse claude-swap's or codex-swap's on-disk stores directly.
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

- Skills under `skills/<name>/` ship through AgentStart's private core plugin
  (`~/code/agentstart/scripts/sync-skills`, run six-hourly by the scheduled
  updater): Claude Code and Codex expose them under the `agentstart-core`
  plugin namespace, while Pi uses the plain skill name. A SKILL.md edit is
  live within six hours, or on demand by running that script. Whether a new
  skill earns a TOOLS.md advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
