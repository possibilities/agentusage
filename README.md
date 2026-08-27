# AgentUsage

[![CI](https://github.com/possibilities/agentusage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentusage/actions/workflows/ci.yml)

How much capacity every Claude and Codex account has left, in one place: a
background observer, a live TUI, and one explicit `balance` verb that launchers
call to pick an account.

This is the standalone rebuild of keeper's `usage` subsystem, with
[claude-swap] and [codex-swap] as the per-provider account managers and durable
observation stores.

[claude-swap]: https://github.com/possibilities/claude-swap
[codex-swap]: https://github.com/possibilities/codex-swap

```
                       ┌─────────────────────────┐
  cswap list --json ◄──┤ agentusage observer      ├──► codex-swap snapshot --json
  cswap recover N  ◄──┤  3min + jitter cadence   │
                       └───────────┬─────────────┘
                                   ▼ atomic 0600 sidecars
                  ~/.local/state/agentusage/{account-routing,codex-account-routing}/observation.json
                                   ▼
        agentusage (TUI · status · balance · focus)  ◄── launchers call `balance … --json`
```

The providers own the truth: claude-swap persists last-good usage per account,
and codex-swap keeps a SQLite store with trust, backoff, and leases. agentusage
shells their JSON CLIs and normalizes the results into observation sidecars. It
never parses their on-disk stores directly.

For Claude cards, `●` means the account is a route in a fresh observation. A
dim `○` means the account has an issue or the provider observation is stale;
`sampled … ago` is diagnostic metadata and does not demote a route that cswap
still reports as trusted.

## Install

Via AgentStart (preferred — it installs the command, its provider CLIs, and the
`agentusage.observer` service):

```bash
~/code/agentstart/scripts/install.sh --install
```

Or directly:

```bash
bash scripts/install.sh --install
```

Either path also installs the provider CLIs best-effort
(`scripts/install-providers.sh`):

- **cswap** — installed by the [cswax](https://github.com/possibilities/cswax)
  workshop, which owns the public
  [`possibilities/claude-swap`](https://github.com/possibilities/claude-swap)
  fork. Its `integration` branch carries `subscriptionType`/`rateLimitMultiplier`
  on `--json` rows for cross-tier capacity comparison, and `cswap recover`, the
  owner-held expired-token recovery the daemon runs one-due-per-cycle.
  `scripts/install-providers.sh` calls `cswax/scripts/install.sh --install
  --published` and does nothing else about the fork: the workshop clones it when
  absent, binds a clean checkout to the published commit, and refuses dirty,
  divergent, or unpublished provider code. Rebasing the fork onto upstream is
  cswax's `/maintain` cycle, deliberately run — never a side effect of an
  install.
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

The observer (`agentusage.observer` LaunchAgent, logs at
`~/.local/state/agentusage/observer.log`) starts observing immediately. Until
accounts exist, every surface renders absent, empty, and stale states honestly.

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
agentusage recover <route|claude-N>
                                 one explicit cswap token recovery
agentusage refresh [claude|codex|all]
agentusage daemon run|status
```

The TUI follows the fleet chromeless-shell contract: no header or footer
rows and no identity row — the usage frame is the whole surface. A
transient overlay chip announces a running refresh, and every action lives
in the ctrl+k command palette — type to filter, arrows to select, enter to
run, rows tappable — which doubles as the key reference. Direct hotkeys
keep working while the palette is closed.

## Launcher integration

agentusage picks; the launcher launches. Contract:

**Claude** — `agentusage balance claude --json [--fable|--no-fable|--model m]`
returns `{ ok, route: {id, slot}, display_name, reason, … }`. Launch with
`cswap run <slot> --share-history -- <claude args…>`. Selection is keeper's
algorithm. Fable intent covers the Fable model and Claude's 1M-context model
spellings (`*-1m` and `*[1m]`); `--fable` / `--no-fable` explicitly override
model inference. Selection is applied in order:

1. eligibility — session and weekly windows present and under 100%, with a
   Fable window required for Fable intent;
2. Fable conservation — Fable launches chase the lowest Fable utilization;
   non-Fable launches prefer Fable-less accounts, then the most-burned Fable;
3. +5 pp pressure per live reservation (90 s TTL);
4. least-recently-selected, then lexicographic.

`--dry-run` previews without reserving. `--account <route|cN>` pins the pick
(reason `requested-account`) but still runs the eligibility gate, refusing
`requested-unknown` or `requested-ineligible` rather than launching into an
exhausted account. An active provider focus (`focus claude`) sits between the
two: an explicit `--account` beats it, and it beats the fable/non-fable overlay
(reasons `full-focus` / `full-focus-fallback`). When the sidecar is older than
5 minutes, balance tries one bounded refresh, then refuses with
`observation-stale` rather than guessing.

**Codex** — `agentusage balance codex --json [--strategy best|next-available]
[--claim]` delegates to `codex-swap select`; with `--claim` the result carries
a lease to consume via `codex-swap run --claim <lease-id> -- …`, otherwise
launch with `codex-swap run --account <accountKey> -- …`. An active codex
focus gates its target against the fresh observation, then delegates through
`codex-swap select --account <accountKey>` so focused launches retain the same
atomic lease accounting as automatic selections.

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
agentusage focus fable set claude-2 permanent            # all Fable launches → claude-2
agentusage focus fable set claude-2 cycle-end            # …until the observed Fable window resets or hits 100%
agentusage focus fable set claude-2 current-reset        # …until that reset time (absolute)
agentusage focus non-fable set claude-1 absolute 2026-08-12T00:00:00Z
agentusage focus fable clear
```

`set` warns when the target is not currently launch-eligible, and
`--require-eligible` turns that warning into a refusal. The two observed
lifetimes read the reset out of the live Fable window, so they need a fresh
healthy observation. `--expect-reset <UTC>` asserts which reset you meant and
fails `reset-mismatch` if the window has already rolled underneath you.

An active Fable focus also **fences its target out of the non-Fable pool**, so
generic launches stop draining the account you are conserving for Fable.
Effective states are `off · active · expired · invalid · unavailable`, plus
`completed` for observed lifetimes. Expired policies are not auto-cleared
(parity with keeper): routing falls back and `show` names the state. Machine
consumers read focus from `status --json` — `usage --json` carries observations
only.

A **provider focus** pins *every* launch for one provider to a single account —
Fable and non-Fable alike, and for codex the main, spark, and pi paths, since
they all ride `balance codex`. It overrides both intent focuses entirely, fence
included, and stays in charge during fallback while its target is temporarily
ineligible; one policy governs at a time. An explicit `--account` still wins.

Its observed lifetimes follow the **binding weekly window** (Claude `week`,
Codex main-lane weekly) rather than the Fable window, which makes draining an
account whose week resets soon a single command:

```bash
agentusage focus claude set claude-1 cycle-end           # everything → claude-1 until its week resets or hits 100%
agentusage focus codex set <accountKey> current-reset
agentusage focus claude clear
```

Codex targets are accountKeys resolved against a fresh observation. While a
codex focus is active, `balance codex --claim` requests a pinned provider
selection and returns its lease normally. If the target is temporarily
ineligible, the active focus remains in charge while selection falls back to
the ordinary eligible pool.

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

## Develop

```bash
bun test            # no network, temp state roots
bun run typecheck
```

`docs/SKETCH.md` is the build contract, `CONTEXT.md` the glossary. Provider
contracts are pinned to the public claude-swap fork's `integration` branch
(maintained by cswax) and codex-swap `f193bc1`; both are read defensively.
