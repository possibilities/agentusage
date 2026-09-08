# Own Grok's account lifecycle in AgentUsage

Status: Accepted
Date: 2026-09-08

## Context

AgentUsage already owns Claude/Codex credentials, observations and selection.
Grok still required a separate `grok-swap` process for observation and balancing,
with its own credential file, lock and installer dependency. The operator asked
to move that logic into AgentUsage and archive the separate repository.

## Decision

AgentUsage owns Grok device OAuth, credential refresh, billing normalization,
selection, account controls and short reservations in `src/grok/`. The existing
daemon observes Grok in process. CLI account commands cover all three providers;
Grok selection keeps its existing public `balance grok` result and focus behavior.

Keep Grok's provider-specific inventory in private `accounts/grok.json`, using
AgentUsage's atomic fsynced writes and kernel locks. Preserve immutable ordinals,
aliases, last-good billing, exponential backoff, the next-available cursor and
1–300-second reservations. These differ from native proxy session leases, so
Grok does not enter the Claude/Codex proxy pool or gain harness activation.

All production HTTP origins are fixed. Requests and observation cycles are
bounded, redirects are refused, and public results exclude credentials and raw
upstream diagnostic bodies. Verify the account identity before adopting a
credential rotation, then save that rotation before a subsequent billing call.

Moving existing accounts requires an explicit private version-1 snapshot import
into an empty Grok inventory after the previous refresh-token owner has stopped.
There is no legacy-store discovery or automatic merge. An identical repeated
import is harmless; a different occupied inventory is preserved and refused.

## Consequences

The Grok subprocess adapter, executable override, and AgentStart installation
edge are removed. The separate repository can be archived after a coordinated
runtime handoff and verification; private source state remains a stopped backup.
The official Grok Build CLI remains independently installed and authenticated.

Grok retains its 24-hour decision limit for last-good billing and immediate
exclusion after authentication rejection. Dry runs do not reserve or advance
the cursor. Cross-process claims and refreshes share owned locks. Targeted
refreshes publish a complete public inventory so other accounts do not disappear.

A failed identity lookup after OAuth rotation does not adopt unverified
credentials; human reauthentication may be needed if the provider invalidated
the previous token. A verified rotation survives a later billing failure.

This extends the original Claude/Codex scope in
[ACCOUNT-OWNERSHIP.md](../ACCOUNT-OWNERSHIP.md). Credential, billing, selection,
concurrency and CLI acceptance tests live in `test/grok-*.test.ts` and
`test/balance-grok.test.ts`.
