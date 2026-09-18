# 0012: Renew active Fx execution leases

Status: Accepted

## Context

The original bridge gave a managed Fx turn one fixed five-minute execution
deadline. A useful Grok review reached its fifteenth inference while the same
account, target, quota and credential were still valid. The provider response
was cut off at that fixed deadline, correctly leaving delivery uncertain, but
the limit made an otherwise healthy persisted Fx session unusable.

## Decision

Keep five minutes as a rolling authorization horizon instead of a total-session
ceiling. The bridge renews before a provider submission unless a full two-minute
request budget plus a safety margin remains, and also renews idle active
sessions before expiry. Each renewal
uses a unique idempotent broker command and may extend the execution deadline by
at most five minutes from the current time.

Renewal rechecks the same owner, native process, account and exact target
binding. It also rechecks current provider quota, credential generation and
expiry. When a capability capture becomes five minutes old, the authority
fetches the current catalog and verifies that the pinned model, effort and tier
remain supported without changing the binding. A failed renewal is a known
pre-admission refusal: no inference is sent, and a manager may continue the
persisted Fx session through a fresh authorized Execution.

Provider submission remains the uncertainty boundary. A response lost after
submission is still `post_admission`, `may_have_forwarded`, and is never retried.
Cancellation, account changes, quota loss, catalog drift and elapsed leases all
continue to fail closed.

## Consequences

Long tool-use turns can remain active beyond five minutes while authorization
stays current. The bridge still has a finite rolling lease, releases it on
parent EOF, and cannot revive an expired lease. Renewal adds bounded catalog
traffic only when the prior capability capture ages out.
