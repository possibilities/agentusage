# Routing evidence projection

`agentusage routing evidence --json` reads one atomic, non-secret Codex and
Grok quota projection. It does not call a provider or refresh, select, reserve
or mutate an account.

```json
{
  "schema_version": 2,
  "source_revision": "6385791490841077170325537",
  "provider_source_revisions": {
    "codex": 1770000000000,
    "grok": 1770000000001
  },
  "generated_at": "2026-09-16T12:00:00.001Z",
  "usage": {
    "schema_version": 1,
    "generated_at": "2026-09-16T12:00:00.001Z",
    "claude": null,
    "codex": { "schema_version": 2, "source_revision": 1770000000000 },
    "grok": { "schema_version": 1, "source_revision": 1770000000001 }
  },
  "account_generations": [
    {
      "account_key": "codex-1",
      "account_generation": 1,
      "provider_generation": 1
    },
    {
      "account_key": "grok-2",
      "account_generation": 2,
      "provider_generation": 1
    }
  ]
}
```

The command holds both provider refresh locks and both account-state locks in a
fixed order. It validates that each sidecar is exactly reproducible from its
locked account state. It refuses with a sanitized `snapshot_busy`,
`evidence_unavailable`, `inconsistent_snapshot` or `generation_unavailable`
code instead of returning a partial join.

Grok billing samples carry a private SHA-256 correlation to the access token
that measured them. Rotation makes an old sample ineligible for selection and
routing evidence until a provider refresh succeeds. The fingerprint never
appears in public output.

Each provider advances a positive numeric source revision. Version 2 combines
the two revisions with a monotonic Cantor pairing encoded as a decimal string,
because the exact value exceeds JavaScript's safe integer range. Consumers must
preserve and compare the value losslessly. `provider_source_revisions` exposes
the two numeric inputs for diagnostics. Re-reading the same combined revision
produces identical evidence.

For the routing-context composer, map the result directly:

```ts
quota: {
  revision: evidence.source_revision,
  usage: evidence.usage,
  account_generations: evidence.account_generations,
}
```

The output allowlist excludes access and refresh tokens, credential expiry,
raw provider account IDs, email, labels, plan names, arbitrary provider notes,
and provider-authored lane names or feature identifiers. It preserves
timestamps, observation health, recognized quota lanes and numeric windows,
eligibility reasons, cooldowns and lease counts.

## Native manager composition

`agentusage routing compose-native --file - --json` reads a bounded JSON input
from stdin and returns a schema-2 context, without provider calls or state writes.
Inputs join the exact owned native catalog/current settings/runtime identity to
public evidence v1/v2. The reviewed role catalog is
`agentvoice-role-catalog-2026-09-14`; new visible models and effort drift disable
recommendations. Native manager account correlation and numerical economics
remain explicitly unavailable. Fresh positive Grok included capacity and Codex
main-lane capacity are independently eligible. The context expires at the earliest
relevant observation freshness/reset boundary. AgentHUD persists the emitted
context and underlying evidence; its consumption receipt is separate from native
transport acceptance. See `src/routing-context/native-manager.ts` for the exact
input/output contract and `test/native-manager-context.test.ts` for examples.
