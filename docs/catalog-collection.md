# Native Codex catalog collection

`agentusage catalog collect` prepares an audit-compatible bundle from supplied
reviewed metadata and one explicitly launched native Codex app-server. It
records every model-list cursor transition and preserves the native order of
explicit capability arrays. It never submits a turn or attaches to an existing
runtime.

The initial protocol profile targets stock Codex CLI **0.154.0**. Verification
for this delivery uses fake executables and fake app-server responses only. It
does not establish compatibility with a real installation or availability for
any actual account.

## Inputs and invocation

The metadata file is bounded to 1 MiB (`--metadata -` reads standard input) and
contains:

```json
{
  "schema_version": 1,
  "metadata": {
    "version": "reviewed-catalog-revision",
    "reviewed_at": "2026-09-16T00:00:00Z",
    "review_after": "2026-09-23T00:00:00Z",
    "sources": ["reviewed source reference"],
    "models": []
  }
}
```

Use the same metadata model shape described in the
[audit contract](catalog-audit.md). The empty list above is a shape illustration,
not a reviewed catalog. Collection never copies discovered capabilities into
reviewed expectations or advances their review deadline.

```sh
agentusage catalog collect --metadata reviewed.json \
  --codex /absolute/path/to/stock/codex \
  --expected-version 0.154.0 --json > captured-bundle.json
agentusage catalog audit --file captured-bundle.json --json
```

The executable must be selected explicitly. Choose the stock executable, not an
AgentStart permission shim or account-selection wrapper. An absolute path alone cannot
prove executable identity. The command checks its bounded `--version` output
against the supported expected version before launching app-server. It does not
accept extra native arguments, remote endpoints or arbitrary RPC methods.

This command is **not offline**. A real executable may read native configuration
and credentials, contact the catalog service or perform native housekeeping.
The collector does not copy credentials, change native configuration, prepare
an account, query account identity, refresh AgentUsage usage or create a lease.
Native behavior remains native-owned. Running the offline audit does none of
this native startup work.

## Protocol and output

The owned child uses newline-delimited JSON over stdio. It receives one
`initialize` request, one `initialized` notification and sequential `model/list`
requests. Every model-list request includes `includeHidden: true`, `limit: 100`
and the exact preceding response's `nextCursor` (null for the first request).
The collector requires explicit efforts, service tiers, input modalities,
default values, visibility and nullable multi-agent support; it does not infer
lists from model names or supplement them with reviewed metadata.

Successful stdout is a version-1 audit bundle. Its `native_catalog` contains
projected model-list pages and a versioned collection receipt with capture
identity, protocol/version evidence, timing and per-page request/cursor facts.
Only a validated chain ending in a null cursor is successful. Failed or partial
collection emits a sanitized error instead of a success bundle. The receipt
records local collection claims; it is not a signature or proof of native
execution. The audit validates receipt consistency but cannot authenticate a
supplied file.

The `native_catalog.capture_receipt` version-1 fields are:

| Field | Meaning |
| --- | --- |
| `profile` | `stock-codex-app-server-0.154.0`, the reviewed collection profile |
| `capture_id` | Fresh UUID for this collection attempt, not a native session ID |
| `expected_version`, `reported_version` | Expected and parsed executable version, both `0.154.0` |
| `started_at`, `completed_at` | Capture timestamps; completion equals `native_catalog.observed_at` |
| `complete` | True only for a validated chain ending in a null cursor |
| `pages` | Ordered receipts with `request_id`, `requested_cursor`, `returned_next_cursor`, `include_hidden`, `limit` and `model_count` |

The first model-list request ID is 2, after initialization ID 1. Receipt IDs
increase by one; the first requested cursor is null and every later cursor must
equal the preceding page's returned cursor. The audit checks this sequence,
page count, per-page model count, supported version and explicit capability
fields. It does not infer receipt authenticity from consistency.

`usage` is always null. No implicit sidecar read or account correlation occurs.
The resulting audit therefore reports missing usage until a caller deliberately
adds separately captured public usage evidence. Capability parity never grants
dispatch, authentication or account-switching authority. The collector omits
native home paths, user-agent strings, stderr, arbitrary response fields and
notification bodies.

Input/output, message sizes, pages, models and elapsed time are bounded. Unknown
or duplicate response identities, unexpected server requests, malformed data,
unsupported versions, timeout and premature exit fail closed. The collector
does not answer approvals or authentication prompts and does not retry a native
request. On success or failure it closes or terminates only its owned process.

The initial collector supports POSIX hosts and owns a detached process group so
descendants retaining pipe descriptors can be terminated too. The Windows path
is explicitly unsupported. Defaults are a three-second version check, five
seconds per protocol request, thirty seconds for catalog collection, and bounded
shutdown grace periods. Collection permits at most 128 pages, 100 models per
page and 512 models total. Raw app-server stdout is capped at 2 MiB, one JSONL
buffer at 512 KiB, and stderr at 64 KiB. The emitted compact bundle, including
its final newline, must fit the audit's 1 MiB input limit.

Exit 0 means a complete validated capture was produced; exit 2 means input,
version, protocol or process failure. An audit of that capture may independently
exit 1 for missing usage, capability drift or stale evidence.

## Follow-up boundary

An explicitly authorized no-turn probe against an identified stock binary can
test real release compatibility later. It must not attach to or reconfigure an
active AgentVoice call. Runtime/account binding, account preparation, FX
credential brokering, model recommendations and manager execution remain
separate work. See [ADR 0003](adr/0003-collect-versioned-native-catalogs.md).
