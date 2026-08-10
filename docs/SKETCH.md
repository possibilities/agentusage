# agentusage — build sketch

Self-approved 2026-08-08 under Mike's standing authorization; investigation
reports from four explorers (keeper usage, claude-swap fork, codex-swap, funk
installers) are the evidence base.

## Goal

Give this account keeper-`usage` parity as a standalone tool: an observation
daemon, an explicit `balance` command for launchers, Fable/Non-Fable focus, and
an OpenTUI usage view — over Claude accounts (via claude-swap) and Codex
accounts (via codex-swap), installed by funk as a launchagent.

## Direction

- **Provider contract is CLI JSON, not files.** The daemon shells
  `cswap list --json` (3 min + 30 s jitter, weekly-reset early wake — keeper's
  cadence) and `codex-swap snapshot --json` (same cadence; codex-swap's own
  poll plans govern actual network fetches) and writes normalized sidecars
  under `~/.local/state/agentusage/` — atomic 0600 tmp+rename. claude-swap and
  codex-swap remain the durable observation stores (both persist last-good
  usage); our sidecars are the render/decision surface, exactly keeper's
  split.
- **Claude sidecar keeps keeper's Observation schema v7 shape** (routes vs
  account_issues invariant, capacity metadata, per-account measurements) so
  the balance port is faithful. Codex sidecar is a new v1 shape built on
  codex-swap's Snapshot contract, with windows grouped into **lanes** —
  `gpt-5.3-codex-spark` becomes a first-class non-binding lane via the
  `limitName`/`meteredFeature` fields the codex-swap agent just landed.
- **Balance is explicit** (keeper buried it inside the launcher's
  `selectRoute()`). `balance claude` ports keeper's algorithm: eligibility
  gate (session+week present and <100 %, Fable window required for Fable
  intent), Fable-conservation scoring (Fable launches chase lowest Fable
  utilization; non-Fable launches prefer Fable-less accounts, then
  most-burned Fable), reservation pressure (+5 pp per live reservation, 90 s
  TTL flock ledger), LRU → lexicographic tie-breaks, focus overlay with
  keeper's reason vocabulary. `balance codex` delegates to `codex-swap
  select` (claude-swap-approach parity — none of the old pi subagent
  balancing); a `--model` matching *spark* instead selects on spark-lane
  headroom locally, ignoring main-quota exhaustion since spark is an
  independent lane that survives main exhaustion.
- **Focus ports keeper's contract minus the event-sourcing.** Same policy
  shapes and lifetimes (`permanent`, `absolute`, Fable-only `current-reset`
  and `cycle-end`), same effective states including cycle-end completion
  (window at the pinned boundary hits 100 %), stored as hardened JSON leaves
  (0600, O_EXCL+rename, group/other-writable refused on read) written
  directly by the CLI — no daemon round-trip, since we have no SQLite event
  rail and don't need one.
- **TUI is `@opentui/core`** like keeper's, but a real renderable tree instead
  of one flat string: per-account cards, utilization-colored bars, reset
  countdowns, spark lane rows, focus badges, staleness dimming. Sidecar-backed
  at 1 Hz, daemon-independent, snapshot mode when piped, `--json` envelope.
- **Install copies the agentweb shape** (the new account's convention):
  project-owned `scripts/install.sh` — bun-shim bins `agentusage` +
  `agentusaged`, rendered `agentusage.daemon` plist with ownership marker and
  bootout/bootstrap dance, receipt in `~/.local/state/agentusage/` — plus funk
  edits wiring it into Agentdots' `install-agent-clis` / funk's `verify-local-services`.
  Providers are provisioned by `scripts/install-providers.sh`: claude-swap
  from `~/src/claude-swap` with fork remote and an `integration/agentusage`
  branch (current upstream + open PRs #169 capacity-metadata + #166 recover)
  via `uv tool install`; codex-swap shimmed to `node src/cli/main.ts` until it
  grows its own installer.
- **Daemon recovery parity:** after each Claude cycle, at most one due
  `cswap recover <slot> --json` for a token-expired account (PR #166
  behavior keeper relied on), non-fatal.

## Touchpoints

- `src/paths.ts` — roots, files, env overrides (`AGENTUSAGE_STATE_ROOT`,
  `AGENTUSAGE_CSWAP_BIN`, `AGENTUSAGE_CODEX_SWAP_BIN`).
- `src/claude/types.ts` + `src/claude/observe.ts` — keeper-v7 Observation
  types, `cswap list --json` normalization, validation invariant.
- `src/codex/types.ts` + `src/codex/observe.ts` — codex observation v1,
  snapshot normalization, lane grouping + spark labeling.
- `src/sidecar.ts` — atomic read/write, freshness.
- `src/refresh.ts` — provider-safe locked refresh (non-blocking flock;
  contended → bounded re-read).
- `src/focus.ts` — policy types, leaf IO, effective-state evaluation.
- `src/balance/claude.ts` — eligibility, scoring, ledger, focus overlay.
- `src/balance/codex.ts` — `codex-swap select` delegation + spark selection.
- `src/daemon.ts` — both provider loops + recovery; `agentusaged` entry.
- `src/cli.ts` — dispatch: `usage` (default), `status`, `balance`, `focus`,
  `recover`, `refresh`, `daemon`, `help`, `version`.
- `src/tui/` — view model + OpenTUI app; `src/snapshot.ts` — piped frame.
- `scripts/install.sh`, `scripts/install-providers.sh`. The daemon's
  LaunchAgent is Agentdots': `~/code/agentdots/config/launchd/`.
- `~/code/agentdots`: `scripts/install-agent-clis`, `scripts/install-launchagents`.
- `~/code/funk`: `libexec/verify-local-services`, `install`, `bin/funk` usage text.
- `~/src/claude-swap`: fork remote + `integration/agentusage` branch.
- `test/` — normalization, balance scoring/tie-breaks/focus overlay, focus
  lifetimes, spark grouping/selection, sidecar IO.

## Risks & unknowns

- PR #166 (627-line recovery) may conflict when cherry-picked onto upstream
  0.25; fallback is #169-only with recovery degraded to a documented manual
  step.
- No accounts are onboarded on this machine yet (cswap store absent,
  codex-swap pool empty) — every surface must render absent/empty states
  honestly; end-to-end verification with real data waits on Mike's logins.
- codex-swap is under active development; contract pinned at `f193bc1`
  (additive since `efce453`), defensive parsing everywhere, live coordination
  over the agent bus.
- `@opentui/core` 0.3 component-tree API differs from keeper's flat-string
  usage; prototype the TUI early to de-risk.

## Open decisions

None blocking. Two defaults chosen: codex `balance` claims are opt-in
(`--claim`), and focus auto-clear is not ported (keeper never shipped it
either — expired policies persist with effective-state fallback).

## Addendum: provider-wide focus (2026-08-09)

First deliberate extension beyond keeper parity, sketched and approved in
session. `focus claude` / `focus codex` pin **every** launch for a provider
to one account, overriding the Fable/Non-Fable focuses — fence included, and
also during fallback while the target is temporarily ineligible (fallback is
plain scoring; one policy is in charge at a time). Explicit `--account`
requests still win. Same hardened leaf machinery, one leaf per provider
(`account-routing/full-focus-policy.json`,
`codex-account-routing/full-focus-policy.json`); policy shape carries
`provider` + `target` (route id / accountKey) and all four lifetimes, with
the observed ones (`current-reset`, `cycle-end`) reading the **binding
weekly window** (claude `week`, codex main-lane secondary), not the Fable
window. New selection reasons `full-focus` / `full-focus-fallback` extend
keeper's vocabulary. Codex pins select locally from the observation
(codex-swap `select` has no account pin), so `--claim` refuses
(`focus-claim-unsupported`) rather than unpinning; lifting that needs
`select --account` upstream in codex-swap.
