# Offline Codex catalog audit

`agentusage catalog audit --file BUNDLE --json` compares supplied reviewed
expectations with captured native capabilities and optional quota evidence.
Use `--file -` for standard input. Input is bounded to 1 MiB.

The command reads only the supplied bundle. It does not query Codex, inspect
account files or sidecars, refresh quota, create a lease, change focus, invoke a
model, send a notification or write state. It can run without a native Codex
installation or a running AgentUsage daemon.

Every output keeps `identity_correlation: "unavailable"`,
`routing_enabled: false` and `selection: null`. Agreement between the supplied
captures does not prove that a running process uses a managed account, or that
an account can launch a particular model. Capture provenance is supplied by the
caller, not authenticated by the auditor.

## Prepare the bundle

The top-level version-1 shape is:

```json
{
  "schema_version": 1,
  "metadata": {
    "version": "reviewed-catalog-revision",
    "reviewed_at": "2026-09-16T00:00:00Z",
    "review_after": "2026-09-23T00:00:00Z",
    "sources": ["https://learn.chatgpt.com/docs/app-server"],
    "models": [
      {
        "model_id": "example-model",
        "expected": {
          "hidden": false,
          "efforts": ["low", "medium"],
          "default_effort": "medium",
          "service_tiers": ["priority"],
          "default_service_tier": null,
          "is_default": true,
          "multi_agent_version": "v2",
          "input_modalities": ["text", "image"]
        }
      }
    ]
  },
  "native_catalog": {
    "source": "codex_app_server_model_list",
    "client_version": "captured-cli-version",
    "observed_at": "2026-09-16T00:01:00Z",
    "pages": [
      {
        "data": [
          {
            "id": "example-model",
            "model": "example-model",
            "hidden": false,
            "supportedReasoningEfforts": [
              {"reasoningEffort": "low", "description": "Example"},
              {"reasoningEffort": "medium", "description": "Example"}
            ],
            "defaultReasoningEffort": "medium",
            "serviceTiers": [{"id": "priority", "name": "Example", "description": "Example"}],
            "defaultServiceTier": null,
            "isDefault": true,
            "multiAgentVersion": "v2",
            "inputModalities": ["text", "image"]
          }
        ],
        "nextCursor": null
      }
    ]
  },
  "usage": null
}
```

This is a shape illustration using an invented model and fixed timestamps,
not a reviewed live catalog. It will report stale/missing evidence when used as
written. Do not copy discovered capabilities into reviewed metadata merely to
silence drift: review the source and intended policy, then advance its version.
AgentStart owns fleet manager orientation; this command does not publish it.

Supply complete native `model/list` result objects in response order, including
their `nextCursor` values. Model identity comes from the usable `model` field.
The last page must have `nextCursor: null` to establish capture completeness.
An unfinished page chain stays partial and cannot establish that a reviewed
model disappeared. Duplicate model IDs or repeated/impossible cursor chains
are invalid input. These fields do not independently prove that every page was
actually collected. The explicit [collector](catalog-collection.md) additionally
records request/cursor receipts; the audit checks their consistency when present.
Neither supplied pages nor supplied receipts authenticate native execution.

The native schema is version-dependent. Preserve the version used to capture
it; source documentation and generated schemas describe that exact version.
`serviceTiers` is authoritative when present, including an empty list. The
deprecated `additionalSpeedTiers` is a compatibility input only when the modern
field is absent. Native capability arrays are normalized before fingerprinting,
so ordering alone does not cause drift.

`usage` may be null or the complete public `agentusage usage --json` envelope,
with its independent version-2 Codex observation. The auditor projects only
Codex account keys, health/measurement and quota facts. It omits email, provider
account IDs, labels, raw errors and unrelated providers. It does not call
`agentusage status` or consume that command's account recommendation. Unknown
input fields are not reflected in output.

## Interpret the result

The report separates supplied reviewed metadata, reported native capabilities,
quota observations and diagnostics. Its capability fingerprint changes when
material capabilities change, independently of input ordering. It flags missing
reviewed metadata, missing models in a complete capture, capability drift,
overdue review and incomplete, stale or future-dated evidence.

Sidecar publication time and account measurement time are checked separately.
Native captures, usage publication, observation and individual measurements have
a five-minute freshness ceiling and five-second future-clock tolerance. These
are diagnostic limits, not a new refresh schedule. The report preserves the
supplied `reported_decision_grade`; its effective `decision_grade` also requires
fresh publication and observation, healthy observation, a current fresh
measurement and no reset crossed since measurement. It does not establish
account eligibility or launch authority.
Last-good data and past reset deadlines do not establish renewed decision-grade
capacity. Main and Spark remain separate quota lanes. Spark quota is not evidence
that a Spark model is in the supplied native catalog.

Exit codes:

- `0`: supplied evidence passes the diagnostic checks; routing remains disabled.
- `1`: a valid report contains diagnostics requiring review or fresher evidence.
- `2`: malformed, unsupported, oversized or unreadable input, or invalid CLI use.

Errors are sanitized and do not echo input bodies. Retain the JSON output and
capture references with the review. It is a diagnostic, not a dispatch receipt,
account lease, cost prediction or proof of native execution.

## Follow-up boundary

The explicit collector can capture native capabilities without submitting a
turn; its initial validation uses fake processes only. A separate runtime/account
correlation contract is still necessary before
model/account recommendations become actionable. Paid execution, automatic
account ranking, FX/Grok credential activation, drift notifications and HUD
controller operations are separate stages. See
[ADR 0002](adr/0002-audit-supplied-codex-catalog-evidence.md).
