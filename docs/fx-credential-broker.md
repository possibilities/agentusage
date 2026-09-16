# Fx credential broker contract

The Fx credential broker is AgentUsage's bounded consumer contract for an
AgentFX execution. The durable contract is tested with synthetic Codex and Grok authorities.
A bounded Codex production authority and private bridge are described below.

## Boundary

AgentFX may supply:

- an opaque managed key (`codex-N` or `grok-N`) and expected account/provider
  generations from a prior selection;
- the exact target identity, model, effort, tier, protocol, catalog capture and
  capability digest;
- its host incarnation, control epoch, execution and attempt IDs;
- an execution deadline, bounded lease TTL and a fresh 32-byte consumer nonce;
- after activation, its native process instance, Fx build and session identity;
- bounded provider request bytes and safe non-authorization headers.

AgentUsage returns a public binding receipt containing only opaque identity,
generations, exact target facts, lifecycle state, timestamps and non-secret
digests. `prepare` also returns a private handoff capability. That capability is
for the AgentFX host adapter only: it must not enter manager responses, AgentHUD,
logs or durable consumer state.

The authority implementation behind `FxBrokerAuthority` resolves credentials,
performs any refresh and injects provider authorization. The broker never
accepts authorization, host or account-selection headers. It never persists
request/response bodies, consumer nonces, capability plaintext, provider tokens
or refresh material. Credential revisions are private AgentUsage state and do
not appear in receipts. Provider response headers are reduced to bounded
`content-type` and `retry-after` values before they cross the boundary; a real
authority must sanitize response bodies because it alone can recognize its
credential material.

## Lifecycle

1. `prepare` validates the broker incarnation, selection generations and exact
   target; it atomically claims the account and issues lease revision 1.
2. `activate` presents the private capability and binds one process/build/session,
   advancing the revision. Another account claim or activation loses its fence.
3. `forward` rechecks every account, target, owner, process and revision fence.
   It records an uncertain admission receipt before calling the authority. The
   authority alone resolves and refreshes credentials. A lost response is never
   retried automatically.
4. `renew` extends the lease only within its execution deadline. `release` is
   the normal consumer terminal transition; AgentUsage may use the separate
   privileged `revoke` operation independently.
5. Time expiry and terminal states are absorbing. Opening a new broker
   incarnation revokes all live leases and invalidates their capabilities.

Every mutating command is bounded to 16 KiB and every request ID is bound to a
canonical command digest. Provider bodies and responses are bounded to 1 MiB.
The operation ledger holds at most 4,096 entries and the lease ledger 1,024.
Exact refusal receipts distinguish stale fences, generations, capabilities,
targets, authorization, unsupported adapters, expiry/revocation and uncertain
provider admission.

Historical `prepare` and `forward` receipts can be recovered after a crash by
reissuing the same semantic command with the new broker-incarnation transport
fence. Historical prepare recovery never returns a private handoff for the old
incarnation. Forward recovery returns lifecycle evidence only; response bodies
are intentionally not durable.

## Current integration limit

`src/fx-broker/` is an internal production contract and durable state machine.
The daemon remains unchanged. The private CLI bridge now connects AgentFX to
a bounded Codex production authority; the Grok production authority remains
unavailable. Synthetic tests continue to cover both providers at the contract
boundary.

## Bounded production transport

`agentusage fx-bridge` now supplies a private stdio transport to AgentFX for one
bounded Codex execution. It takes a schema-1 selection (account key, model,
effort, service tier and exact routing source revision), host/execution owner
and deadline on stdin; returns a prepared receipt and **private** random loopback
URLs; accepts exact native process/build/session activation; and releases on EOF,
explicit release or deadline. This command is a host interface, not a manager
JSON diagnostic: never display or persist its raw stdout.

The managed authority requires fresh atomic quota evidence, a complete binding
lane with unpassed resets and a current provider catalog. It pins all request
settings and refuses other providers until their equivalent authority is wired.
It uses existing AgentUsage-owned account refresh locking. It does not require a
daemon restart. See ADR 0007 for bounds, secret containment and recovery limits.
