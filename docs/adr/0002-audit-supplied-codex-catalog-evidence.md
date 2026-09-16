# Audit supplied Codex catalog and quota evidence

Status: Accepted for the diagnostic slice
Date: 2026-09-16

## Context

Quota-aware orchestration needs three different facts: reviewed model guidance,
the native harness's callable model capabilities, and managed-account quota.
AgentUsage owns the third fact. Its quota lanes do not establish native model
availability, the identity of an already-running native process, or the model
that executed. Native catalog collection likewise does not establish that it
used a particular managed account.

The first implementation must make these gaps inspectable without obtaining
credentials, creating leases, invoking models or changing running sessions.

## Decision

Add an offline Codex catalog audit to AgentUsage. It consumes an explicitly
supplied, bounded versioned JSON bundle containing reviewed expected capabilities,
captured `model/list` response pages and an optional public `usage --json`
snapshot. It never launches a collector, reads ambient account state, fetches a
provider, refreshes an observation or updates authored metadata.

The diagnostic compares model IDs and capabilities, reports incomplete or stale
evidence, and projects a bounded account/quota view without email, provider
account IDs or arbitrary source fields. Missing metadata and missing models stay
distinct; a partial native inventory cannot establish model absence. Capability
fingerprints normalize ordering and retain material settings independently.
Quota measurement time is separate from sidecar publication time. Reset passage
requires refreshed evidence; it never supplies capacity by itself.

Every report declares runtime identity correlation unavailable, routing disabled
and selection null. Clean parity means the supplied evidence agrees at audit
time, not that any account can launch any model. Input provenance is supplied by
the caller, not authenticated by this command. No credential or authority can be
created by a reviewed metadata document.

AgentStart remains the owner of manager orientation and any future reviewed
fleet model catalog. This command accepts such a catalog but does not publish or
silently maintain one. AgentHUD remains the durable Work and association owner;
the audit does not dispatch, bind, accept, present or close Work.

## Consequences

The command is useful in captured-evidence reviews and fixture/CI checks before
introducing automatic routing. It deliberately requires prepared captures:
collection and exact runtime/account identity are later, separately bounded
contracts. Current native schemas, not dated model names or API price tables,
remain the source for callable capabilities.

Grok/FX activation, live native collectors, account ranking, paid inference,
notification delivery and controller operations are outside this slice. There
is no new daemon, installation dependency or cross-tool subprocess edge.

Tests use synthetic snapshots and disposable files to cover capability drift,
pagination/coverage, stale measurements, input bounds, redaction and exit codes.
The existing account, selection and daemon suites continue to run unchanged.

This refines the observation boundary in [account ownership](../ACCOUNT-OWNERSHIP.md)
without changing credential ownership, proxy behavior or launcher activation.
