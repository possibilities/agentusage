# 0014: Align the Fx provider-admission ceiling

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

AgentFX replaced its fixed twenty-minute prompt timeout with a renewable
twenty-minute idle deadline and a two-hour absolute safety ceiling. The prior
AgentUsage bridge limits of 32 Codex admissions and 256 Grok admissions could
therefore terminate a valid tool-heavy execution before the controller's
activity and safety policy. One preserved productive Grok execution made 62
successful provider admissions in twenty minutes, which projects beyond the
old Grok cap during a valid two-hour turn.

The rolling five-minute lease, pre-admission renewal checks, finite 235-second
provider-response budget, parent-EOF release, and AgentFX absolute ceiling
already provide the primary time and ownership bounds. A provider-admission
count remains useful as defense in depth, but should not be the ordinary lower
deadline.

## Decision

Use one finite limit of 1,024 provider admissions for both Codex and Grok bridge
executions. Keep the limit in the shared runtime-bounds module alongside the
rolling lease and provider-response policy. Reaching it remains a known
pre-admission refusal with no provider forward and no automatic retry.

Do not change lease renewal, provider response, cancellation, release, owner or
native-binding validation, or post-admission unknown-outcome semantics.

## Consequences

- The AgentFX two-hour absolute ceiling dominates ordinary productive turns at
  the observed admission rate.
- Codex and Grok use one maintainable bridge limit.
- A pathological request loop still encounters a finite hard refusal even
  before AgentFX's wall-clock ceiling when it exceeds 1,024 admissions.
