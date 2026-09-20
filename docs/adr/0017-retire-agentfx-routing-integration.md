# 0017: Retire AgentFX routing integration

Status: Accepted 2026-09-20 at the operator's request.

## Context

AgentUsage had become the account and evidence layer for a live AgentFX/Grok
routing stack. It owned an `fx-bridge` subprocess contract, durable broker
state, provider mediation, atomic Codex/Grok routing projections, native-manager
context composition, reviewed manager economics, and authenticated Grok model
catalog capture. AgentVoice consumed those projections and AgentFX used the
bridge and catalog evidence for managed executions.

The operator retired that integration. AgentVoice has removed its live routing
producer and preserved prior routing items only as transcript history. AgentLab's
Fx adapter independently translates the native ACP protocol through a
host-injected transport; it neither uses AgentUsage nor makes AgentUsage an Fx
process, credential, or attachment owner.

## Decision

Remove the `agentusage fx-bridge` and `agentusage routing` CLI surfaces and
their broker, bridge, routing-evidence, native-manager composition, economics,
and Grok model-catalog implementations. Ordinary Grok refresh performs only the
owned OAuth, identity, and billing work required for account observation and
selection; it makes no `/v1/models` or `/v1/language-models` request and no
longer writes or prunes catalog state.

Preserve AgentUsage's Claude, Codex, and Grok account ownership, OAuth refresh,
billing and usage observations, focus and balancing policy, Claude/Codex native
proxy preparation and session leases, observer daemon, and independent offline
Codex catalog audit and explicit native catalog collector. AgentGrok, Grok Bot,
native Grok Build, Fx, fxnk, and AgentLab's direct ACP adapter remain outside
this retired integration.

Retirement does not delete or rewrite existing
`grok-account-routing/catalog.json`, `service/fx-broker.json`, routing sidecars,
or external consumer receipts. Existing observation validators continue to
accept historical optional source revisions. The retired files remain ordinary
JSON and repository history remains the schema reference; no migration or
archive action is part of this change.

## Consequences

AgentUsage startup and Grok observation no longer depend on model-catalog
availability, and an ordinary billing refresh has one smaller network surface.
Saved callers of `fx-bridge` or `routing` receive the existing top-level
invalid-command behavior and cannot reactivate the retired pipeline.

ADRs 0004–0006, 0008, and 0009–0016 are superseded as live contracts. ADRs
0001–0003 and 0007 remain current: AgentUsage still owns Grok account and
billing state, and the separate offline Codex catalog workflows remain
available.
