# 0007: Interpret an omitted Grok credits percentage as zero

Status: Accepted

## Context

The modern Grok Build credits endpoint returns a proto3-backed
`GetGrokCreditsConfig` shape. A current included-allowance window is expressed
by `currentPeriod`, and consumption is expressed by the scalar
`creditUsagePercent`. Proto3 JSON omits scalar fields at their default value.
Consequently, a newly reset unified-billing account can return a complete
weekly period while omitting `creditUsagePercent`; AgentUsage previously
classified that fresh account as `usage_unknown` instead of 0% used.

Treating every absent percentage as zero would be unsafe because legacy,
partial, or changed response shapes can omit the same field for other reasons.

## Decision

AgentUsage interprets an omitted `creditUsagePercent` as 0% used and 100%
remaining only when all of the following are true:

- the field is absent rather than present with an invalid or null value;
- `isUnifiedBillingUser` is explicitly true;
- `currentPeriod.type` is explicitly weekly or monthly; and
- the current period has parseable start and end timestamps.

Explicit percentages remain authoritative. The tested legacy
`monthlyLimit`/`used` ratio remains the fallback for the deprecated shape.
Every other missing, partial, malformed, or legacy response keeps included
usage unknown and therefore cannot authorize included-allowance selection.

## Consequences

A freshly reset unified Grok subscription becomes decision-grade immediately
and can be selected from its included allowance. Schema drift and ambiguous
responses still fail closed. The inference is fixture-tested independently of
the live account and requires no raw provider response to be retained or
published.
