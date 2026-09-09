# Account ownership in AgentUsage

Approved by the operator's 2026-09-07 instruction to build a confident sketch
inside AgentUsage. This supersedes the Claude/Codex provider ownership and
launcher sections of SKETCH.md. Grok's adapter was outside that original scope;
the operator's 2026-09-08 extension is recorded in
[ADR 0001](adr/0001-own-grok-account-lifecycle.md).

## Goal

Own Claude and Codex account inventory, authentication, usage collection,
selection, and activation in AgentUsage. Preserve AgentLaunch's native flags,
resources, account pins, and a common history/configuration per harness.

## Direction

- Store credentials under AgentUsage's private state directory; use atomic,
  durable writes and kernel flock around mutations and token refresh.
- Extend the existing observer daemon with one authenticated loopback proxy.
  A native process receives an opaque session credential, never a refresh
  token. Explicit pins stay fixed; automatic Codex leases may change after a
  confirmed quota rejection, including across daemon restart.
- Forward native requests with bounded concurrency, bodies, and timeouts;
  preserve streams, cancellation, response headers, and upstream errors. Retry
  authentication once against the same account. A second rejection quarantines
  that credential generation. The operator added automatic Codex quota failover: only replay an explicit usage-limit rejection of a self-contained
  unpinned request, at most three accounts, before streaming begins. Stored
  response, conversation, file, container, template and encrypted-reasoning
  references prevent cross-account replay.
- Keep native harness homes and AgentLaunch resource arguments. AgentLaunch's
  existing process renews/releases the session lease over HTTP; no additional
  per-session wrapper, app-server, or heartbeat process is introduced.
- Declare AgentUsage's Codex model provider with
  `requires_openai_auth=false`. Managed Codex sessions keep the shared native
  home for history and configuration, but native OpenAI authentication and its
  account-limit features cannot select or change their model. The opaque lease
  bearer is the provider-specific authentication for the loopback proxy.
- Provide account list, native login/import, disable/enable, remove, and
  recovery commands in the existing CLI. Preserve focus, quota lanes, reset
  credits, dry runs, and concurrency-aware selection.
- Remove swap subprocesses and installation edges for Claude/Codex. No native
  harness patch, new repository, new public binary, or upstream patch queue.

## Touchpoints

- `src/accounts/`: private store, account lifecycle, OAuth and direct usage.
- `src/service/`: persistent account leases, loopback proxy, launch preparation.
- `src/claude`, `src/codex`, `src/balance`, `src/cli.ts`, `src/daemon.ts`:
  in-process account providers, selection, recovery, and daemon lifecycle.
- AgentLaunch: preparation, native environment, lease renewal and cleanup.
- AgentStart: retire the two swap installation dependencies, keep one service,
  update statusline account identity and `skills/fleet/MAP.md`.
- CLI guide, README, CONTEXT, AGENTS, installer, and acceptance tests.

## Risks and acceptance

- The earlier synthetic proof reproduced duplicate native refresh grants.
  AgentUsage must be the only credential owner: importing credentials while
  old swap/native sessions still refresh them is not an automatic cutover.
- Codex's custom-provider account-feature limits already exist in today's
  proxy path. Shared configuration/history and explicit native resume must
  pass; changing native Codex is excluded.
- One daemon is a shared request dependency. Durable pins survive restart;
  outstanding requests may fail, and expired leases fail closed.
- Claude's subscription is inactive. Local native authentication/transport and
  history tests are required; live subscription acceptance remains distinct.

Run the complete AgentUsage and affected fleet suites plus native mock
acceptance. Reap every test child and server. GPT-6 Astra at high effort is the
recommended independent review for credential isolation and concurrency.
