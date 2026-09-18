# 0009: Mediate bounded Fx Codex and Grok executions

Status: Accepted

## Decision

Extend ADR 0004's broker with `agentusage fx-bridge`, a private stdio consumer
transport for one AgentFX execution. AgentUsage resolves the exact managed Codex
account, rechecks atomic decision-grade routing evidence and the supplied source
revision, obtains a fresh fixed-origin provider catalog and validates the exact
model, effort and service tier. Provider credentials and refresh remain inside
AgentUsage. No inference or refresh retry is introduced.

A kernel lock permits one bridge globally. Opening a competing bridge cannot
revoke the current broker incarnation. The parent receives only public binding
receipts and one private, random loopback endpoint. Catalog reads may precede
activation; Responses forwarding requires the exact native process/build/session
activation fence. Origin/auth/cookie-bearing requests are refused. Parent EOF,
explicit release or a maximum five-minute deadline closes the owned listener.
Each Codex execution permits at most 32 admissions and each Grok execution at
most 256. Grok's permissive ceiling makes the four-minute AgentFX deadline the
practical bound for normal tool-use turns while retaining a finite guard against
a pathological request loop; Codex keeps the tighter guard for its finite main
quota. Every admission still revalidates current provider authority. Exhausting
either limit emits explicit non-success admission evidence before closing, so
the controller cannot accept an HTTP error as a completed task. Any failed or
uncertain admission closes further admission. Provider bodies/responses are
bounded to one MiB and buffered; a lost response retains the broker's existing
unknown-outcome contract.

Managed preparation and inference may wait up to five seconds for the atomic
routing snapshot, further bounded by the execution deadline and cancellation.
Only acquisition of the fixed Codex-refresh, Grok-refresh, Codex-account and
Grok-account lock sequence is retried. A partial sequence is released before
each attempt; projection and authority callbacks run once after all locks are
held. The public routing-evidence command remains non-blocking.

The broker and bridge preserve a fixed, sanitized pre-admission refusal
receipt: stage, allowlisted code, disposition, retry policy and provider
delivery certainty. Snapshot contention, capacity, authorization, target and
storage refusals therefore remain `not_forwarded`; arbitrary messages, paths,
endpoints, request/response bodies and account-private fields are discarded.
Once a provider call starts, any lost or invalid result remains
`post_admission` with `may_have_forwarded`, and is never retried.

This first authority supports Codex only. It does not change the current native
manager's account, spend reset credits, expose Grok as eligible without evidence,
or restart the observer daemon. AgentFX owns native child lifetime and semantic
Work association. The broker proves settings/account admission, not task success.

## Verification and limits

Synthetic authority and transport tests cover stale/reset/exhausted evidence,
source revision, catalog/effort/tier drift, exact request settings, credentials,
activation, browser request refusal, failed-provider retry refusal and release.
The live Fx integration must additionally prove its catalog compatibility and
that an ACP-completed HTTP error is not accepted as a successful task result.
A maximum four-minute AgentFX attempt avoids renewal and provides a small first
production slice. Longer tasks and concurrent accounts require a later service
transport using the same broker fences.

The Codex catalog request explicitly supplies the repository's reviewed collector
compatibility version (`SUPPORTED_COLLECTOR_VERSION`, currently 0.154.0).
The provider rejects a catalog request without this version. This is protocol
compatibility metadata; it does not claim the native manager executed that build.

The Grok authority joins fresh included quota, current reset and credential fingerprint to a fixed subscription Responses endpoint. Exact account, admission source revision, model, reasoning effort and tier remain pinned for the lease. It fetches subscription capabilities and xAI modalities separately and contains both credentials and provider account identifiers. No numerical cross-provider economics are inferred. Broker preparation validates the exact aggregate evidence revision. Each active inference accepts the same or a newer selected-provider publication only after revalidating current positive quota, reset, credential and account facts; a regressed provider revision refuses. This prevents a normal periodic observation from revoking safe work while still failing before the next provider call when current authority becomes unsafe. An unrelated provider publication also cannot revoke an already-prepared lease. The bridge holds the atomic observation/account snapshot through catalog validation and durable broker preparation, so a normal observation publication cannot age a selected exact revision between the gate and its lease. A credential that would expire during the bounded execution refuses instead of refreshing inside that revision fence.

Fx's automatic Grok permission reviewer emits a distinct Responses request with
its built-in reviewer model and no task reasoning or tier settings. The private
Grok authority recognizes only that bounded `permission_decision` request shape
and normalizes its model, effort and tier to the lease's exact task target before
provider admission. This keeps code-profile shell review inside the already
pinned capability instead of either rejecting the review or admitting a second,
unfenced model.

For a manager decision that already fixes account, model, effort and tier, the
bridge also accepts the explicit `broker_prepare` revision mode. It resolves
that mode to the current exact routing revision inside the same locked broker
preparation transaction and returns the resolved revision to AgentFX for
durable evidence. This closes the otherwise unavoidable gap between a
read-only manager orientation and child startup without accepting the older
evidence or retrying a failed attempt. Exact-revision input retains its existing
strict conflict behavior.
