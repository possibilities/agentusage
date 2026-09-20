# 0016: Publish Fx bridge runtime identity and effective bounds

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

An installed bridge completed 34 provider forwards and then refused forward 35
with `capacity_unavailable`, even though the current source ceiling was 1,024.
Existing execution evidence identified the broker lease and Fx child but not
the AgentUsage executable, build/source bytes, or effective bridge bounds. A
stale installed runtime therefore looked like a current-source provider
capacity refusal.

Paths, argv, environment, provider content, credentials, account identifiers,
and arbitrary error text are not safe durable evidence.

## Decision

The schema-1 `prepared` bridge message carries required `bridge_runtime`
evidence. It contains privacy-safe SHA-256 identities for the running Bun
executable bytes, the loaded bridge implementation, and their composed build;
the bounded product/runtime versions; and the effective admission,
stdio, request-body, rolling-lease, and provider-response limits. It contains
no paths or private request/provider values.

The executable content digest is captured during module initialization, before
broker preparation can await external work. The source digest covers the
immutable loaded function representations of the bridge entrypoint, its local
ID/invalid-request/refusal helpers, and the runtime
evidence encoder/hash helpers. Effective imported bounds are recorded as exact
numbers instead of hashing their mutable source files. The build digest composes
the product/runtime/platform identities, executable content digest, loaded
source digest, and those effective bounds. It deliberately excludes transitive
provider-authority modules, whose capability and broker receipts are separate
evidence. No runtime identity reads mutable source files after module load.

An admission-ceiling refusal additionally records the successful admission
count and effective limit. The count is the number already forwarded, so a
refusal for request 1,025 records `admission_count: 1024` and
`admission_limit: 1024`.

AgentFX validates and persists this required evidence before treating the
private transport as prepared. Older AgentFX consumers ignore the additive
field; a new AgentFX paired with an older AgentUsage bridge fails visibly before
Fx or provider admission. Deploy AgentUsage before AgentFX.

## Consequences

Loaded-code/install drift and an obsolete admission ceiling are recoverable from one
execution without reading secrets or retrying the provider attempt. The
identity digests prove exact observed executable bytes and loaded function
representations; they do not claim a Git commit, a clean checkout, or task
success.
