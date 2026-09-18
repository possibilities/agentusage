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

Managed snapshot acquisition has a five-second ceiling and is also bounded by
the execution deadline and cancellation. Contention retries release every
partially acquired lock before retrying the fixed lock order. No authority
callback or provider inference is retried. Known failures before provider
admission cross the bridge only as a fixed receipt containing `stage`, `code`,
`disposition`, `retry`, and `provider_delivery`; provider-started uncertainty
retains `may_have_forwarded` and the existing fail-closed behavior.

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

## Bounded production transport

`agentusage fx-bridge` now supplies a private stdio transport to AgentFX for one
bounded Codex execution. It takes a schema-1 selection (account key, model,
effort, service tier and either an exact routing source revision or the explicit
`broker_prepare` mode), host/execution owner
and deadline on stdin; returns a prepared receipt and **private** random loopback
URLs; accepts exact native process/build/session activation; and releases on EOF,
explicit release or deadline. This command is a host interface, not a manager
JSON diagnostic: never display or persist its raw stdout.

The managed authority requires fresh atomic quota evidence, a complete binding
lane with unpassed resets and a current provider catalog. It holds that exact
snapshot through catalog validation and durable broker preparation, so an
observation publisher cannot advance the selected revision between those two
steps. It pins all request settings; credentials that cannot cover the bounded
attempt refuse rather than refreshing inside the revision fence. It does not
require a daemon restart. See ADR 0007 for bounds, secret containment and
recovery limits.

The production bridge supports Codex and Grok using the fixed owner-controlled Responses endpoints. Broker preparation pins the selected aggregate routing evidence revision (v1 integer or v2 lossless decimal string). Each inference accepts the same or a newer selected-provider component revision only after revalidating fresh positive quota, reset, account and credential facts; a regressed revision or unsafe current fact refuses before the provider call. This lets normal observation publication coexist with one bounded execution without weakening the initial exact-revision admission gate. An unrelated provider publication also does not revoke the lease. Grok joins its current included reset and credential fingerprint, plus provider model/effort and modality catalogs. `agentfx run` and MCP consume this private bridge; neither receives credentials. See [ADR 0009](adr/0009-mediate-bounded-fx-executions.md).

`broker_prepare` resolves to the current exact revision while the bridge holds
the atomic observation/account snapshot through catalog validation and durable
lease preparation. The prepared response carries that resolved revision. This
mode is for callers whose explicit account/model/effort/tier choice is already
fixed but whose earlier read-only orientation can age before process startup.
It does not reuse the earlier revision, retry a refusal, or relax quota,
credential, target, generation, freshness, or broker idempotency checks.
