# Routing evidence projection

`agentusage routing evidence --json` reads one atomic, non-secret Codex quota
projection. It does not call a provider or refresh, select, reserve or mutate an
account.

```json
{
  "schema_version": 1,
  "source_revision": 1770000000000,
  "generated_at": "2026-09-16T12:00:00.000Z",
  "usage": {
    "schema_version": 1,
    "generated_at": "2026-09-16T12:00:00.000Z",
    "claude": null,
    "codex": { "schema_version": 2, "source_revision": 1770000000000 },
    "grok": null
  },
  "account_generations": [
    {
      "account_key": "codex-1",
      "account_generation": 1,
      "provider_generation": 1
    }
  ]
}
```

The command holds the Codex observation and account-pool locks together and
validates that the sidecar is exactly reproducible from that pool. It refuses
with a sanitized `snapshot_busy`, `evidence_unavailable`,
`inconsistent_snapshot` or `generation_unavailable` code instead of returning
a partial join.

`generated_at` is the source observation publication time. Re-reading the same
`source_revision` produces identical evidence rather than changing a timestamp
under an unchanged revision.

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
eligibility reasons, cooldowns and lease counts. Version 1 is Codex-only.
