# 0006: Project atomic public routing evidence

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

The version-1 format and Codex-only limitation are superseded by ADR 0008.
The Codex locking, sanitization and generation decisions below remain active.

## Context

The routing-context composer requires public usage and exact account/provider
generations from one source revision. `agentusage usage --json` reads public
sidecars, while the generations remain in AgentUsage's private account pool.
Reading those files independently can mix an old observation with a new account
authority. Exposing the pool would also disclose credentials, provider IDs,
email, labels and subscription metadata.

## Decision

AgentUsage exposes `agentusage routing evidence --json`. The command takes the
Codex observation lock, then the account-pool lock, matching the existing
refresh lock order. While both are held it reads the sidecar and pool and
rebuilds the observation from the pool. Any mismatch, duplicate/missing
identity, unavailable generation or lock contention refuses the whole request.
It never refreshes a provider, selects an account or mutates account state.

The projection has schema version 1 and carries one `source_revision`, one
source-publication `generated_at`, a sanitized `usage` envelope and sorted
`account_generations`. Re-reading one source revision returns byte-equivalent
evidence; wall-clock read time never creates a same-revision content conflict.
`usage.codex` preserves observation and measurement timestamps, health,
decision-grade state, quota lanes, resets, cooldowns and lease pressure. It
replaces email, label, ordinal and plan values with null, omits the raw provider
account ID, and removes arbitrary notes. Claude and Grok are null in version 1.

The managed account's never-reused ordinal is its `account_generation`.
`provider_generation` is the generation of AgentUsage's provider-authority
contract, currently one. OAuth credential rotation is a separate private
revision and does not replace that authority. Successful usage publication
records the private credential generation that authenticated the measurement
and refuses a concurrently changed generation. An eligible account is projected
only when that measurement revision matches the current credential revision.
Legacy credential-generation-one measurements are unambiguous; later legacy
measurements without provenance are refused.

Codex sidecar publications advance an explicit positive `source_revision` past
the previous revision even when the wall clock is equal or regresses. A legacy
sidecar uses its positive `observed_at_ms` as its initial source revision. The
routing-context composer consumes `source_revision` as its quota revision and
the other two fields without translation.

## Consequences

The result is a public, no-spend evidence boundary suitable for deterministic
composition and fixture tests. It does not authenticate a broker receipt,
reserve capacity, persist a routing-context snapshot, schedule collection,
inject manager input or make Claude/Grok routing evidence available. An
AgentHUD adapter may persist the resulting composed snapshot and consumed
receipt after revalidating its expiry and source revision.
