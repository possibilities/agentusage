# Glossary

**Provider** — the account service `claude`, `codex`, or `grok`. AgentUsage owns each provider's credentials, observations and selection. _Avoid_: backend, vendor.

**Managed account** — an AgentUsage-owned OAuth identity and credentials. Its stable key is `claude-N`, `codex-N`, or `grok-N`; removal never reuses N. Claude/Codex proxy requests also track credential generations. _Avoid_: profile, swap account.

**Ordinal** — the immutable positive number in a managed account key. Observation view indexes are zero-based presentation fields, not identities.

**Route** — a launchable Claude managed account. Every observed account has either a route or an issue, never both and never neither.

**Slot** — the positive ordinal carried in a Claude route for selection bookkeeping. It no longer names a provider command.

**Display name** — the stable managed key. Account selectors can also use an unambiguous provider identity, email, label, or ordinal.

**Grok inventory** — the private `accounts/grok.json` leaf containing Grok identities, credentials, last-good billing, backoff, selection cursor and reservations. AgentUsage is its sole owner. _Avoid_: Grok subprocess, swap adapter.

**Observation** — one normalized provider reading in a sidecar. Claude schema 8, Codex schema 2, and Grok schema 1 are independent envelopes.

**Catalog audit** — an offline comparison of supplied reviewed model metadata,
captured native Codex capabilities and optional public quota evidence. It does
not establish a runtime's managed account or select a model/account. _Avoid_:
live catalog, router, authenticated identity join.

**Catalog collection** — an explicit, bounded native app-server session that
records a complete model-list pagination chain for a reviewed protocol version.
It preserves reported capabilities but does not establish a managed account,
executed model or authenticated capture provenance. _Avoid_: offline audit,
runtime attachment, account activation.

**Sidecar** — the atomically replaced JSON file under `~/.local/state/agentusage/` read by the viewer, status and balance commands. The managed account pool remains authoritative for credentials and last-good usage. _Avoid_: cache.

**Decision-grade** — provider-specific evidence sufficient for selection. Claude/Codex require fresh, successful usage with complete binding windows. Grok retains last-good billing for at most 24 hours, including after a non-authentication billing error; missing capacity needs explicit `--allow-unknown`, and invalid or rejected credentials always refuse.

**Freshness ceiling** — the five-minute limit for public observation freshness and Claude/Codex decision measurements. Grok's owned selector separately applies its 24-hour last-good billing limit; a newly published sidecar does not renew that billing timestamp.

**Lane** — Codex windows sharing a quota pool: `main`, `codex-spark`, `code-review`, or another metered feature. _Avoid_: window (one lane contains several).

**Reserve lane** — Opaque Codex additional-lane metadata such as
`gpt-reserve`. AgentUsage may display its reported meters, but neither it nor
`normal_model_slug` changes eligibility, routing, or the requested model.

**Spark lane** — independent Codex Spark quota, identified by the provider's limit name or metered feature. Main quota exhaustion does not exhaust Spark.

**Binding window** — a window that limits eligibility: Claude session and week, Codex main primary and secondary, or Grok's included allowance before paid fallback.

**Reset credit** — a one-shot provider allowance to reset Codex quota. Display only; AgentUsage never spends it or changes eligibility from its presence.

**Included allowance** — Grok's percentage-based billing-period meter. Prepaid balance and pay-as-you-go are monetary facts, never utilization percentages.

**Focus** — durable account preference, subject to capacity and authentication gates. Provider focus overrides Claude's Fable and non-Fable focuses. Lifetimes are permanent, absolute, or an observed current-reset/cycle-end; non-Fable focus supports permanent and absolute only.

**Balance** — account selection and optional short reservation. It does not launch a native process. Launchers use prepare for authentication. _Avoid_: activation.

**Prepare** — selection plus an authenticated native launch contract, issued by `agentusage prepare`. A real prepare requires the daemon; dry-run is read-only and contains no credential.

**Session lease** — a 90-second account assignment authenticated by an opaque bearer credential. The existing launcher parent renews and releases it. Explicit pins stay fixed; automatic Codex assignments can change after a confirmed, replayable quota rejection. Native history identity does not change.

**Fx credential broker** — the AgentUsage-owned, fail-closed authority that
pins an opaque `codex-N` or `grok-N` account and exact target capability to one
AgentFX execution/attempt, then mediates provider requests without exporting
credentials. Its synthetic authority proves the contract; no real Fx adapter is
enabled yet. _Avoid_: credential export, writable identity copy, ambient auth.

**Fx binding receipt** — non-secret lifecycle evidence for one broker lease. It
includes broker/account/provider generations, the exact target capability,
owner and native-process fences, expiry, state and digests. The separate private
handoff capability is never manager or HUD evidence. _Avoid_: credential lease,
provider token.

**Provider failure diagnostic** — The nullable HTTP status and finite normalized
error category retained after an Fx provider admission. It never contains a
response body, provider message, credential, provider account identifier,
prompt or request content. _Avoid_: provider error text, response excerpt.

**Fx bridge runtime evidence** — Privacy-safe exact digests for the running
AgentUsage executable bytes, loaded bridge functions and composed build, plus
bounded product/runtime versions and effective bridge limits. It contains no
paths, argv, environment, provider content, credentials or account identifiers.
_Avoid_: Git revision claim, raw bridge stdout, install path.

**Routing context** — A monotonic, non-secret AgentUsage composition of explicit
current model/effort/tier, reviewed task-fit and within-provider cost guidance,
captured native capabilities, public quota, opaque Fx binding receipts and the
exact AgentHUD host/control identity. Version 1 is a pure synthetic Codex/Fx
contract; it never schedules a refresh, delivers a manager turn or reserves
capacity. _Avoid_: prompt update, router, credential handoff.

**Context revision** — The monotonic revision inside one numeric routing-context
producer generation. The ordered generation/revision pair identifies newer
state. Identical evidence coalesces; missed revisions or generation changes
require a full snapshot. A consumed-revision receipt records observation by a
consumer, not execution or Work acceptance. _Avoid_: provider revision, command
receipt.

**Manager economics** — Reviewed official API text-token prices used only to
order Codex models within OpenAI. They do not measure subscription quota or
compare Codex with Grok. The separate Grok preference preserves finite Codex
main quota when an eligible included-allowance target is compatible. _Avoid_:
cross-provider price, predicted task cost, quota multiplier.

**Routing evidence projection** — A read-only, sanitized AgentUsage snapshot
that joins one locked Codex observation to the exact managed-account pool and
supplies composer-ready usage plus opaque generations. It never refreshes a
provider. Email, labels, provider account IDs, plan names, notes and credential
material are absent. _Avoid_: account listing, credential snapshot, routing
decision.

**Grok catalog routing evidence** — A revision-fenced, non-secret projection of
the last-good authenticated `/v1/models` and `/v1/language-models` captures for
every owned Grok account, joined to current included quota and reviewed model
metadata. Complete visibility includes intentionally incompatible rows;
routability requires a fresh current-credential capture, compatible Responses
capability, positive included quota and reviewed guidance. _Avoid_: raw provider
catalog, inferred capability, cross-provider price.

**Routing source revision** — The strictly monotonic revision assigned when a
Codex observation sidecar is published. A legacy sidecar without the explicit
field uses its positive observation timestamp once; subsequent publishers
advance past it even if the wall clock regresses. _Avoid_: context revision,
credential generation.

**Account generation** — The never-reused positive managed-account ordinal used
as the opaque lifecycle fence for a managed key. **Provider generation** — The
positive generation of AgentUsage's provider authority contract, currently one.
Credential rotation is a separate private revision and does not replace that
authority. Eligible routing evidence requires its quota measurement's private
credential generation to match the current one. _Avoid_: credential generation,
observation timestamp, lease revision.

**Reservation** — a short-lived selection-pressure record. Claude balance keeps a local ledger; managed launches also hold session leases. Grok's inventory records reservations for 1–300 seconds when a caller explicitly claims a selection.

**Quota cooldown** — a lane-specific exclusion recorded from an explicit Codex usage-limit rejection. It is separate from transient request throttling and survives daemon restart; a newer trusted positive measurement for that lane confirms recovery and clears it.

**Launcher** — the process owner, such as AgentLaunch, that applies prepare arguments and environment, starts the native CLI, and maintains its lease. Native homes, trust, configuration and history remain native.
