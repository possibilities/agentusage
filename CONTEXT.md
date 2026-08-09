# Glossary

**Provider** — a source of managed accounts: `claude` (served by claude-swap's
`cswap` CLI) or `codex` (served by codex-swap). _Avoid_: "backend", "vendor".

**Observation** — one normalized reading of a provider's account capacity,
written as a sidecar file. Claude observations use keeper's schema v7 shape;
codex observations use agentusage schema v1. _Avoid_: "snapshot" for the
sidecar (codex-swap's `snapshot` command is the provider's own term).

**Sidecar** — the atomically-replaced JSON file under
`~/.local/state/agentusage/` that consumers (TUI, balance, status) read;
providers' own stores stay authoritative. _Avoid_: "cache".

**Route** — a launchable Claude account identity, `claude-swap:<slot>`.
PII-free and durable. Only launch-eligible accounts become routes; every other
account carries an issue instead — never both, never neither.

**Slot** — claude-swap's positive-integer account number, the argument to
`cswap run <slot>`.

**Ordinal** — zero-based display position (`c0`, `c1`, …) of a Claude account
in cswap inventory order; how humans name routes in commands.

**Lane** — a group of Codex rate-limit windows that share one quota pool: the
binding `main` lane (primary 5 h + secondary weekly), the non-binding
`codex-spark` lane, `code-review`, or another metered feature. _Avoid_:
"scope" (keeper's Claude term), "window" (one lane holds several).

**Spark lane** — the `gpt-5.3-codex-spark` lane: independent quota that does
not drain the main lane and keeps working when main quota is exhausted.
Identified by `limitName`/`meteredFeature` containing "spark".

**Binding window** — a window that counts toward eligibility and headroom
(Claude: `session` + `week`; Codex: the main lane's primary + secondary).
Non-binding lanes are display + lane-targeted balance only.

**Focus** — a durable policy pinning launches to one route. **Fable focus**
pins Fable-intent launches; **Non-Fable focus** pins everything else. An
active Fable focus also fences its target out of the non-Fable pool. A
**provider focus** (`focus claude` / `focus codex`) pins every launch for
that provider to one account and overrides both intent focuses, fence
included. Lifetimes: `permanent`, `absolute`, and observed `current-reset` /
`cycle-end` (Fable focus reads the Fable window, provider focus the binding
weekly window; Non-Fable focus has only the first two). Effective states:
`off | active | expired | invalid | unavailable` (+ `completed` for observed
lifetimes).

**Balance** — the explicit account-selection verb a launcher calls
(`agentusage balance <provider> --json`); prints the chosen account, does not
launch. _Avoid_: "routing" for the command itself (keeper's implicit form).

**Reservation** — a 90 s-TTL record that a balance decision was handed out,
adding +5 pp pressure per live reservation so concurrent launches spread.

**Freshness ceiling** — the maximum sidecar age (5 min) at which balance will
act; staler observations refuse rather than guess.

**Decision-grade** — codex-swap's own trust verdict on a measurement
(`usage.decisionGrade`); stale-but-displayable numbers live in
`lastGoodUsage`.

**Launcher** — the external tool that actually starts `claude` / `codex`
using balance's answer (e.g. via `cswap run <slot> --share-history` or
`codex-swap run --account <key>`). Out of scope here; contract documented in
README.
