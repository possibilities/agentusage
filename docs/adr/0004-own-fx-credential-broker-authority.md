# 0004: Own Fx credential-broker authority

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

AgentFX can own a full `fx acp` process and its session lifecycle, but a managed
`codex-N` or `grok-N` identity cannot be activated through Fx without crossing
a credential boundary. Returning tokens, copying managed credentials into a
writable Fx profile, or letting AgentFX refresh them would split the ownership
established by the account lifecycle contracts. Account selection alone is not
proof that a later native process still uses the selected identity or target.

## Decision

AgentUsage owns the Fx credential broker. A prepare command pins an opaque
account key, account and provider generations, an exact target capability and
an AgentFX execution/attempt fence. AgentUsage returns a public binding receipt
and a separate private, short-lived activation capability. Activation binds the
lease to one native process, Fx build and optional session. Consumer renew,
release and provider forwarding require the capability, current lease revision,
owner fence and broker incarnation. Revocation is a separate privileged
AgentUsage control operation and never accepts a consumer capability.

AgentUsage remains the only component allowed to resolve credentials or
refresh them. AgentFX supplies bounded request bytes to the broker; the
AgentUsage authority injects authorization and returns a bounded, sanitized
provider response. Public receipts contain stable account keys, generations,
exact target facts, digests and lifecycle state, but no token, refresh material,
credential revision, provider account identifier, request body or provider
authorization header. Private durable state retains the last credential
revision counter only so a rollback fails closed; it never stores credential
material.

Each command has a caller-generated request ID and canonical digest. Repeating
the same semantic command returns its durable receipt; changing its input is an
idempotency conflict. Forwarding records `outcome_unknown` before provider
admission and never automatically repeats an uncertain request. A broker restart
increments its epoch, revokes live leases and fences all capabilities. Historical
prepare and forward receipts remain recoverable with the same semantic command,
but prepare never reconstructs a capability for a revoked incarnation.

The first implementation exposes the TypeScript contract and durable state
machine with a synthetic authority only. Production Codex and Grok adapters and
the private AgentFX transport remain disabled until their credential and
process-handoff compatibility is independently proven.

## Consequences

The manager and AgentHUD can correlate a selection, native process and terminal
lease state without receiving usable credential material. Account rotation,
target drift, expiry, revocation, concurrent claims and broker restart all fail
closed. Provider requests serialize under the AgentUsage broker lock, so a
credential refresh has one owner and concurrent consumers cannot race refresh.

Real model execution is still unavailable through this contract. A later
adapter must resolve the opaque account key inside AgentUsage, prove that Fx can
consume the mediated protocol without credential export, and add a private
process boundary. That work must preserve this receipt and refusal contract.
