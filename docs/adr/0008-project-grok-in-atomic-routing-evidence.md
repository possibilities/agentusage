# 0008: Project Grok in atomic routing evidence

Status: Accepted

## Context

Routing evidence version 1 joined only Codex quota with its private account
authority. The manager must also see current Grok capacity, and the two provider
observations refresh independently. A Grok last-good sample also lacked proof
that it was measured with the currently stored access token.

## Decision

Routing evidence version 2 locks the Codex refresh boundary, Grok refresh
boundary, Codex account pool and Grok account state in that fixed order. It
rebuilds and compares both public observations from the locked private state
and refuses the whole read on contention, absence or mismatch.

Every successful Grok billing observation stores a private SHA-256 fingerprint
of the access token used for the request. Selection and routing evidence require
that fingerprint to match the current credential. Legacy samples and samples
preceding credential rotation are not decision-grade until one successful
refresh records current provenance. The fingerprint is never projected.

Grok publications gain the same monotonic positive source revision as Codex.
The version-2 top-level revision is the Cantor pairing of the Codex and Grok
revisions, plus one, encoded as a decimal string. This is monotonic when either
provider advances, collision-free for the pair, and lossless beyond
JavaScript's safe integer range. The individual numeric revisions remain in
`provider_source_revisions`. The routing-context composer accepts positive
numeric or decimal-string quota revisions and compares them as integers.

The public Grok projection preserves quota percentages, periods, timestamps,
health and fixed error codes. It removes email, aliases, credential expiry,
subscription tier, provider notes and arbitrary error messages. Account
generation is the never-reused Grok ordinal; provider authority generation is
one.

## Consequences

The manager-facing quota input can now contain current Codex and Grok capacity
without a provider call or secret-bearing join. A credential rotation creates a
temporary fail-closed state until refresh, rather than silently routing from an
old allowance. Consumers of routing evidence must support schema version 2 and
lossless string revisions; migration adapters may continue reading stored
version-1 Codex-only records.

This supersedes ADR 0006's version-1 format and Codex-only limitation. ADR
0006's Codex locking, sanitization and generation decisions remain in force.
