# 0005: Compose versioned routing context from public evidence

Status: Accepted for synthetic composition

## Context

Reviewed model guidance, collected native capabilities, public quota observations,
opaque Fx broker receipts and AgentHUD control identities now have separate owners
and contracts. A manager needs one bounded view of those facts, but none of the
individual records proves the complete join. Copying them into a prompt would
also lose freshness, generation and consumption semantics.

## Decision

AgentUsage owns a pure routing-context composer. This is the narrowest owner
because AgentUsage already owns quota evidence and the account-generation broker
receipt. AgentHUD remains authoritative for host and control identity, and
AgentStart remains authoritative for reviewed guidance; both enter as explicit
public evidence. The composer does not recreate either authority.

The version-1 composer supports a Codex target executed through an Fx session. It
requires an explicit current model, effort, service tier, execution, attempt and
native binding. It joins one reviewed guidance row, an exact collected native
capability, fresh public Codex usage, one active current-account broker receipt,
optional prepared alternative-account receipts, and one active AgentHUD host and
control domain. Catalog capture ID, capability digest, broker/account generations,
host incarnation, control epoch, execution, attempt, process and session must all
agree. Ambiguous, stale, regressed or same-revision/different-content evidence is
refused.

Each published full snapshot has a monotonic context revision within a numeric
producer generation, content digests, source revisions, `observed_at` and the earliest
`expires_at`. Native catalog, quota publication, provider observation and the
current account measurement use an exclusive five-minute freshness ceiling. A
fresh publication never renews an old account measurement. Broker expiry and the
metadata review deadline may shorten the snapshot lifetime.

Reviewed cost guidance is explicitly scoped to one provider and one named unit.
The composer carries it through; it does not convert it to money, compare it with
another provider or predict task cost. Configured remaining-capacity bands are
part of reviewed guidance. A crossing is material, while refreshed evidence with
the same decision facts is a heartbeat. Account/auth availability, lane/reset,
lease/cooldown and exact host, catalog or metadata changes are also represented in
the decision digest.

Identical evidence coalesces without consuming a revision. The ordered
`(producer_generation, context_revision)` pair selects newer pending state, and a
higher generation may restart its local revision. Sequential mutable updates may use a quota delta;
an initial delivery, revision gap, producer-generation change or static metadata,
catalog or HUD change requires a full snapshot. Full and delta deliveries carry a
delivery digest over their generation, revision, context digest and payload. A pure consumed-revision receipt records the exact context and
delivery digests, revision, consumer, valid consumption time and delivery mode.

The output is allowlisted. It includes stable account keys, generations, quota
meters and non-secret identities, but omits provider account IDs, email, labels,
credentials, private broker capabilities, arbitrary provider notes and source
prose.

## Consequences

The contract can be exercised entirely with fixtures and cannot refresh usage,
prepare a broker lease, mutate an account, schedule a heartbeat, write HUD state,
attach a manager turn or execute a provider. Callers remain responsible for
persisting revisions, scheduling collection, delivering at a safe boundary and
recording an authoritative consumed receipt.

Grok is deliberately refused in version 1 because there is no reviewed native
catalog and equivalent public quota join for it yet. A production integration
must obtain the source records from their owners and revalidate them at dispatch;
caller-authored JSON and receipts are data-contract evidence, not cryptographic
attestation.
