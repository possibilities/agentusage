# 0015: Retain bounded Fx provider failure diagnostics

Status: Superseded by [ADR 0017](0017-retire-agentfx-routing-integration.md)

## Context

The Fx bridge durably records `outcome_unknown` before provider admission so a
lost response is never replayed. After a response had begun, however, a body
read, decoding or redaction failure discarded even the already known HTTP
status. AgentFX then received only `refresh_outcome_unknown` and
`forward_unknown`. A normal non-200 response exposed its status only in the
ephemeral bridge line, while the durable AgentUsage operation receipt retained
no provider failure reason.

Persisting response bodies or arbitrary provider messages would cross the
credential boundary. Those values can contain tokens, provider account
identifiers, prompts, request content or other uncontrolled text.

## Decision

Every new forward and refusal receipt includes nullable
`provider_http_status` and `provider_error_code`. HTTP status is accepted only
as an integer from 100 through 599. The error code is parsed only from fixed
JSON code fields in a body of at most 16 KiB, normalized from a bounded ASCII
machine-code token, and mapped into this finite vocabulary:

- `authentication_failed`
- `permission_denied`
- `rate_limit_exceeded`
- `quota_exhausted`
- `invalid_request`
- `model_unavailable`
- `server_error`

Unknown codes, malformed envelopes and unavailable bodies produce null. A
provider response-handling error carries only the validated status and category
to the broker; it retains neither its source error nor body. The broker updates
the already durable uncertain receipt before surfacing the fixed refusal. The
private bridge includes the same fields in its normalized receipt and carries
the provider status as its existing `http_status` value when known.

The additive schema-1 change accepts historical seven-field forward and
eight-field refusal receipts. Opening the broker normalizes those legacy
receipts to explicit null diagnostics. Applied responses durably retain their
validated status and optional category; response bodies remain ephemeral and
are still bounded, sanitized and returned only to the private caller.

## Consequences

A provider permission failure can now be distinguished from a transport loss
without storing uncontrolled provider data. If body handling fails after a 403,
the status survives while the category remains null unless it was safely parsed
first. Consumers must treat the fields as diagnostics only: they do not change
delivery certainty, retry authority, quota state or account eligibility.

The finite vocabulary intentionally loses novel provider codes until they are
reviewed and added. This keeps provider messages, identifiers and secret-like
strings outside durable state and manager evidence.
