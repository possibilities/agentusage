# Glossary

**Provider** — the account service `claude`, `codex`, or `grok`. AgentUsage owns each provider's credentials, observations and selection. _Avoid_: backend, vendor.

**Managed account** — an AgentUsage-owned OAuth identity and credentials. Its stable key is `claude-N`, `codex-N`, or `grok-N`; removal never reuses N. Claude/Codex proxy requests also track credential generations. _Avoid_: profile, swap account.

**Ordinal** — the immutable positive number in a managed account key. Observation view indexes are zero-based presentation fields, not identities.

**Route** — a launchable Claude managed account. Every observed account has either a route or an issue, never both and never neither.

**Slot** — the positive ordinal carried in a Claude route for selection bookkeeping. It no longer names a provider command.

**Display name** — the stable managed key. Account selectors can also use an unambiguous provider identity, email, label, or ordinal.

**Grok inventory** — the private `accounts/grok.json` leaf containing Grok identities, credentials, last-good billing, backoff, selection cursor and reservations. AgentUsage is its sole owner. _Avoid_: Grok subprocess, swap adapter.

**Observation** — one normalized provider reading in a sidecar. Claude schema 8, Codex schema 2, and Grok schema 1 are independent envelopes.

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

**Reservation** — a short-lived selection-pressure record. Claude balance keeps a local ledger; managed launches also hold session leases. Grok's inventory records reservations for 1–300 seconds when a caller explicitly claims a selection.

**Quota cooldown** — a lane-specific exclusion recorded from an explicit Codex usage-limit rejection. It is separate from transient request throttling and survives daemon restart.

**Launcher** — the process owner, such as AgentLaunch, that applies prepare arguments and environment, starts the native CLI, and maintains its lease. Native homes, trust, configuration and history remain native.
