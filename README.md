# agentusage

Claude + Codex account capacity in one place: a background observer, a live
TUI, and an explicit `balance` verb that launchers call to pick an account.
This is the standalone rebuild of keeper's `usage` subsystem, with
[claude-swap] and [codex-swap] as the per-provider account managers and
durable observation stores.

[claude-swap]: https://github.com/realiti4/claude-swap
[codex-swap]: ../codex-swap

```
                       ┌─────────────────────────┐
  cswap list --json ◄──┤ agentusaged (launchagent)├──► codex-swap snapshot --json
  cswap recover N  ◄──┤  3min + jitter cadence   │
                       └───────────┬─────────────┘
                                   ▼ atomic 0600 sidecars
                  ~/.local/state/agentusage/{account-routing,codex-account-routing}/observation.json
                                   ▼
        agentusage (TUI · status · balance · focus)  ◄── launchers call `balance … --json`
```

Providers own the truth (claude-swap persists last-good usage per account;
codex-swap keeps a SQLite store with trust/backoff/leases). agentusage shells
their JSON CLIs, normalizes into observation sidecars, and never parses their
on-disk stores directly.

## Install

Via funk (preferred — it is part of `funk install-local-services`):

```bash
funk install-local-services
funk verify-local-services
```

Or directly:

```bash
bash scripts/install.sh --install
```

Either path also provisions the provider CLIs best-effort
(`scripts/install-providers.sh`):

- **cswap** — `uv tool install` from `~/src/claude-swap` on branch
  `integration/agentusage`: current upstream plus the two open PRs the old
  system depended on — [#169] `subscriptionType`/`rateLimitMultiplier` on
  `--json` rows (cross-tier capacity comparison) and [#166] `cswap recover`
  (owner-held expired-token recovery, which the daemon runs one-due-per-cycle).
  The branch also lives on the fork: `possibilities/claude-swap@integration/agentusage`.
  To refresh it onto a newer upstream: fetch upstream, rebase the branch, rerun
  the two cherry-picks if needed, run `uv run pytest`, reinstall.
- **codex-swap** — a source shim at `~/.local/bin/codex-swap` running
  `node src/cli/main.ts` from `~/code/codex-swap` (Node ≥ 24 type stripping),
  so the checkout is always current while that project is under active
  development. Once codex-swap ships its own `scripts/install.sh`, drop the
  shim and let it own its bin.

Then onboard accounts (one-time, interactive):

```bash
cswap add                 # per Claude account, logged in via Claude Code
codex-swap auth add       # per Codex account (device auth)
```

The daemon (`agentusage.daemon` launchagent, logs at
`~/.local/state/agentusage/daemon.log`) starts observing immediately; every
surface renders absent/empty/stale states honestly until accounts exist.

## Commands

```
agentusage                       live TUI (q quit · r refresh · j/k scroll · g/G ends)
agentusage usage --snapshot      one frame + agentusage-meta line (auto when piped)
agentusage usage --watch         force the TUI even when piped or non-TTY
agentusage usage --timeout 5s    wait up to <dur> for a first sidecar before rendering
agentusage usage --json          both observations, machine-readable
agentusage status [--json]       health, focus states, would-choose previews
agentusage balance claude [...]  pick a Claude account (records a reservation)
agentusage balance codex [...]   pick a Codex account (delegates to codex-swap select)
agentusage focus fable|non-fable|claude|codex show|set|clear ...
agentusage recover <c0|route>    one explicit cswap token recovery
agentusage refresh [claude|codex|all]
agentusage daemon run|status
```

## Launcher integration

agentusage picks; the launcher launches. Contract:

**Claude** — `agentusage balance claude --json [--fable|--no-fable|--model m]`
returns `{ ok, route: {id, slot}, ordinal, reason, … }`. Launch with
`cswap run <slot> --share-history -- <claude args…>`. Selection is keeper's
algorithm: eligibility (session + weekly present and < 100%, Fable window
required for Fable intent), Fable conservation (Fable launches chase the
lowest Fable utilization; non-Fable launches prefer Fable-less accounts, then
the most-burned Fable), +5 pp pressure per live reservation (90 s TTL),
least-recently-selected then lexicographic tie-breaks, focus overlay.
`--dry-run` previews without reserving; `--account <route|cN>` pins the pick
(reason `requested-account`) but still runs the eligibility gate, refusing
`requested-unknown` / `requested-ineligible` rather than launching into an
exhausted account. An active provider focus (`focus claude`) sits between
the two: explicit `--account` beats it, and it beats the fable/non-fable
overlay (reasons `full-focus` / `full-focus-fallback`). Refuses
(`observation-stale`) rather than guessing when the sidecar is older than 5
minutes — one bounded refresh is attempted first.

**Codex** — `agentusage balance codex --json [--strategy best|next-available]
[--claim]` delegates to `codex-swap select`; with `--claim` the result carries
a lease to consume via `codex-swap run --claim <lease-id> -- …`, otherwise
launch with `codex-swap run --account <accountKey> -- …`. An active codex
focus pins the pick locally from the observation instead of delegating
(codex-swap select has no account pin), so `--claim` refuses
(`focus-claim-unsupported`) while a focus is active — use the `--account`
launch form, which needs no lease.

**Pi** — pi launches ride the codex pool: the same
`agentusage balance codex --json [--claim]` picks the account, then launch
with `codex-swap pi run --claim <lease-id> -- <pi args…>` (or
`codex-swap pi run --account <accountKey> -- …`). Accounts must be linked
once with `codex-swap pi link`; unlinked accounts refuse pi launches
(codex-swap ADR 0005).

**Spark** — `agentusage balance codex --model gpt-5.3-codex-spark --json`
selects locally on **spark-lane headroom** (min of the lane's 5 h and weekly
remaining), ignoring main-quota exhaustion entirely — spark is an independent
quota lane that keeps working when the main lane is exhausted. Only
auth-broken accounts are excluded. Ties break toward fewer active leases.

Exit codes everywhere: `0` selected, `1` failure, `2` usage, `3` no eligible
account/capacity (matching codex-swap's convention).

## Focus

Durable policies pinning launches to one route, stored as hardened 0600
leaves under `~/.local/state/agentusage/account-routing/` (codex provider
focus: `codex-account-routing/`):

```bash
agentusage focus fable set c1 permanent            # all Fable launches → c1
agentusage focus fable set c1 cycle-end            # …until the observed Fable window resets or hits 100%
agentusage focus fable set c1 current-reset        # …until that reset time (absolute)
agentusage focus non-fable set c0 absolute 2026-08-12T00:00:00Z
agentusage focus fable clear
```

`set` warns when the target is not currently launch-eligible; `--require-eligible`
turns that warning into a refusal. The two observed lifetimes read the reset out
of the live Fable window, so they need a fresh healthy observation;
`--expect-reset <UTC>` asserts which reset you meant and fails `reset-mismatch`
if the window has already rolled underneath you.

An active Fable focus also **fences its target out of the non-Fable pool**, so
generic launches stop draining the account you are conserving for Fable.
Effective states: `off · active · expired · invalid · unavailable`
(+ `completed` for observed lifetimes). Expired policies are not auto-cleared
(parity with keeper); routing simply falls back and `show` names the state.
`usage --json` carries observations only; machine consumers read focus from
`status --json`.

A **provider focus** pins *every* launch for one provider — Fable and
non-Fable alike, and for codex the main, spark, and pi paths, since they all
ride `balance codex` — to a single account, overriding both intent focuses
entirely (fence included, and also during fallback while the target is
temporarily ineligible: one policy is in charge at a time). Explicit
`--account` requests still win. Its observed lifetimes follow the **binding
weekly window** (Claude `week`, Codex main-lane weekly) instead of the Fable
window, which makes draining an account whose week resets soon a single
command:

```bash
agentusage focus claude set c0 cycle-end           # everything → c0 until its week resets or hits 100%
agentusage focus codex set <accountKey> current-reset
agentusage focus claude clear
```

Codex targets are accountKeys resolved against a fresh observation. While a
codex focus is active, `balance codex --claim` refuses
(`focus-claim-unsupported`) — the pick is made locally, so launch with the
lease-less `codex-swap run --account <key>` form.

## Data

- Claude sidecar `account-routing/observation.json` — keeper's schema v7:
  every account is in exactly one of `routes` (launch-eligible, both binding
  windows present) or `account_issues`; display measurements and capacity
  metadata ride alongside. Windows: `session`, `week`, `spend`,
  `model:<name>` with utilization 0..1+.
- Codex sidecar `codex-account-routing/observation.json` — agentusage schema
  v1 over codex-swap's snapshot: per account auth/trust/selection state plus
  windows regrouped into **lanes** (`main` binding, `codex-spark`,
  `code-review`, extras) with used/remaining percent and reset times.
- Cadence: 3 min + up to 30 s jitter per provider; a weekly window observed at
  100% schedules a one-shot wake 30 s after its reset. Balance trusts
  observations up to 5 min old.
- All refreshes go through a non-blocking per-sidecar lock; contended callers
  re-read instead of stacking provider calls.

## Development

```bash
bun test            # no network, temp state roots
bun run typecheck
```

`docs/SKETCH.md` is the build contract, `CONTEXT.md` the glossary. Provider
contracts are pinned to claude-swap 0.25.0b1 (+ the two PRs) and codex-swap
`f193bc1`; both are read defensively.

[#166]: https://github.com/realiti4/claude-swap/pull/166
[#169]: https://github.com/realiti4/claude-swap/pull/169
