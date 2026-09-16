# Collect versioned native catalogs through an owned stdio child

Status: Accepted for fake-protocol validation
Date: 2026-09-16

## Context

[ADR 0002](0002-audit-supplied-codex-catalog-evidence.md) established an offline
audit of supplied metadata, capabilities and quota. An array of copied response
pages cannot establish that each request used the preceding response's cursor.
Native capability lists also need an explicit schema/version boundary before
future routing work can consume them.

## Decision

Add an explicit operator catalog collector beside the offline audit. It takes
reviewed metadata, a caller-selected absolute stock Codex executable path and an
expected version. The initial profile supports Codex CLI 0.154.0. Version output
must match before app-server startup; unsupported versions are refused rather
than treated as compatible. The implementation is tested with fake executables;
this decision does not claim a successful real-native compatibility probe.

The collector owns one short-lived stdio app-server. Its complete request
surface is initialization followed by sequential `model/list` requests with
hidden models included. It never attaches to a retained server or creates,
resumes, steers or reads a thread. It never requests account identity, prepares
credentials, creates a lease or selects an account. Native startup and catalog
refresh can still use native configuration, credentials, network and state; a
real invocation is not an offline or side-effect-free action.

Successful output is an audit-compatible bundle with `usage: null`, explicit
native capability arrays and a versioned collection receipt. Each page records
its request identity/cursor and returned cursor. Only a validated chain ending
in null is complete. Failed collection emits a sanitized error, never a partial
success bundle. The audit checks receipt consistency when supplied but cannot
authenticate a caller-authored file or prove native execution.

The transport has bounded output, pages, models and deadlines. Unexpected
server requests fail closed; no approval or authentication prompt is answered.
The collector closes or terminates only its owned POSIX process group, including
on errors and cancellation; Windows collection is explicitly unsupported.
It does not retry requests or expose native stderr, home paths or arbitrary
notification bodies in output.

## Consequences

This extends ADR 0002 with explicit collection while preserving its offline
audit semantics and non-routing boundary. AgentUsage still owns account
selection and authentication, and AgentVoice still owns its retained runtime.
The command is not a manager host adapter or account activation mechanism.

The profile comes from the local Codex protocol source at
`112be0bd74ce327788613f4f8f92e8b7c92447c7`, particularly app-server protocol v1
initialization, v2 `model.rs` and the app-server README. Existing fleet native
compatibility evidence includes saved 0.154.0 generated `ModelListParams` and
`ModelListResponse` schemas; no native process was invoked to read those saved
artifacts. The source checkout reports a development package version, so
fake-only verification is explicitly narrower than a release-binary
compatibility claim. Future version support requires reviewed
schema changes and tests; a real probe needs its own authorized boundary.

The new AgentUsage-to-Codex subprocess dependency is recorded in AgentStart's
maintained Fleet map in the paired change. No daemon or service is added.
