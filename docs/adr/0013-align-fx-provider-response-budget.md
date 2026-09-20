# 0013: Align the Fx provider response budget

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

AgentFX raised its ACP prompt deadline to twenty minutes, while AgentUsage still
aborted each admitted provider response after two minutes. A Grok code turn
reached that hidden limit exactly while its five-minute broker authority was
still valid. The resulting post-admission timeout correctly became an unknown
outcome, but the timeout itself prevented the longer prompt contract from
tolerating a slow inference.

## Decision

Give one provider response 235 seconds: the five-minute rolling authority
horizon minus the one-minute idle-renewal window and a five-second persistence
safety margin. Renew before admission unless that full response budget and its
safety margin remain. Codex and Grok share these bounds from one module.

The provider response remains finite and never crosses its admitted lease
deadline. Long ACP prompts still rely on renewal between provider admissions;
this change does not turn one provider request into a twenty-minute lease or
weaken the post-admission unknown-outcome rule.

## Consequences

- A provider response may take nearly four minutes instead of being cut off at
  the former hidden two-minute ceiling.
- The existing five-minute rolling authority, renewal checks, cancellation,
  response-size bound, and no-retry boundary remain unchanged.
- A provider response that exceeds the new bound still ends with an unknown
  outcome and requires a fresh authorized proof rather than replay.
