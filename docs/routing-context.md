# Synthetic routing-context composer

`src/routing-context/index.ts` exports a pure, fixture-friendly contract for
joining public quota and identity evidence. It performs no I/O.

`agentusage routing evidence --json` supplies the quota input as
`revision: source_revision`, `usage` and `account_generations`; callers should
pass those three fields through without reconstructing the join. The quota
revision may be a positive safe integer from legacy evidence or a lossless
decimal string from the multi-provider projection.

`composeRoutingContext(input, previous, nowMs)` returns either a fail-closed error
or a published/coalesced snapshot. The input supplies:

- the explicit current Codex model, effort, service tier and Fx process/session;
- one revisioned reviewed catalog plus task-fit, quota-lane, capacity-band and
  within-Codex subscription-cost guidance;
- one revisioned, complete, version-matched native catalog capture;
- one revisioned public `agentusage usage --json` value plus non-secret
  account/provider generation correlation for every observed account;
- non-secret Fx binding receipts for the active account and any prepared
  alternatives; and
- the exact active AgentHUD host/control-domain projection.

The composer accepts only the collected catalog profile and uses its capture ID
plus a normalized capability digest to bind the broker target. The current broker
receipt must be active and match the execution, attempt, host incarnation,
control epoch, process, build and Fx session. Alternative account receipts must
be prepared, non-expired and target the same capability. Public quota accounts
without a matching receipt remain visible but ineligible.

Snapshots expire at the earliest source boundary. Reviewed metadata must still be
inside its review period. Native catalog, quota publication, Codex observation
and current-account measurement must each be less than five minutes old. Reset
passage after the current-account measurement refuses the snapshot. The active
broker lease and execution deadline must also remain live. Eligible alternatives
add their measurement ceiling, reset/cooldown boundary and prepared-activation
deadline to the snapshot expiry.

The remaining pure helpers model delivery without performing it:

- `coalesceRoutingContext` retains the highest revision and rejects conflicting
  equal revisions inside one numeric producer generation. A higher generation
  supersedes lower generations and may restart its local context revision.
- `planRoutingContextDelivery` emits no update when consumed state is current, a
  compact quota delta for a sequential mutable revision, or a full snapshot after
  a gap, producer-generation change or static-source change.
- `consumeRoutingContext` creates a deterministic receipt for the exact delivered
  revision, full-context digest and a delivery digest binding the generation,
  revision, context digest and full/delta payload while that context
  is still valid.

These types do not create timers, persistence, manager inputs, account leases or
provider requests. A later AgentHUD/controller integration must own those effects
and must request a full current snapshot whenever its consumed revision is absent,
gapped or from another producer generation.
