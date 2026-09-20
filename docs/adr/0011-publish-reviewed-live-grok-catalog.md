# 0011: Publish reviewed live Grok catalog evidence

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

AgentUsage already fetched authenticated Grok catalogs at AgentFX admission, but
kept the raw bytes private and exposed only the selected model check. Managers
therefore saw Grok quota without the complete live model surface and a configured
AgentFX target could remain on an older reviewed model without a visible drift
signal.

## Decision

The owned Grok observation refresh captures both fixed provider catalog
endpoints for every enabled account. It persists only an allowlisted projection:
model ID, Responses compatibility, supported efforts, modalities, context and
output limits, capture time, digest and a private credential fingerprint. Raw
responses, bearer tokens, provider account IDs, email and private endpoints are
never persisted or published. Catalog failure preserves last-good visibility
with a fixed error and does not corrupt a successful billing observation.

`agentusage routing grok-catalog --json` reads the catalog, quota observations
and account authority under the existing atomic routing locks. An optional exact
source revision prevents a manager from joining different quota and catalog
moments. The result distinguishes complete visibility from routability. Every
live row stays visible. Rows absent from the subscription Responses catalog are
intentionally incompatible. Compatible unknown models produce structured drift
and remain unroutable until reviewed metadata is added.

Reviewed Grok 4.6 guidance prefers it for long-running agentic and codebase work;
reviewed Grok 4.5 remains a compatible fallback while live. Per-account
routability additionally requires fresh current-credential capture, supported
text output and reasoning effort, and positive fresh included quota. API or
subscription cost equivalence across providers and within Grok remains
unavailable.

AgentFX may use this public projection only in an explicit configuration
reconciliation transaction. Each execution still starts from one exact persisted
model pin and the private broker repeats live catalog admission. Replay never
changes a target.

## Consequences

The observer adds two bounded non-inference catalog reads when the capture is
missing, stale or credential-changed. Managers can see current and intentionally
excluded models without treating visibility as dispatch authority. New compatible
models fail visibly instead of being silently guessed or omitted.
