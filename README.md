# agentusage

AgentUsage owns Claude and Codex accounts, OAuth refresh, usage observations,
account selection, and one shared native-request proxy. It also shows Grok usage
through grok-swap and provides the existing usage TUI and focus policies.
Claude/Codex operation needs no claude-swap, codex-swap, codex-multi-auth, or
separate balancing CLI.

The existing `agentusage daemon run` process owns the loopback listener and
observation loops. Native sessions receive opaque session credentials; refresh
tokens remain in AgentUsage. AgentLaunch starts the native CLIs and renews leases
in its existing parent process. Native `CODEX_HOME` and `CLAUDE_CONFIG_DIR` remain
unchanged, so account changes preserve shared history, trust, skills and config.

## Install and onboard

Requires Bun >= 1.3.14 and the native Claude/Codex binaries for interactive login.

```sh
bun install --frozen-lockfile
bash scripts/install.sh --install
agentusage accounts login codex --device-auth --label work
agentusage accounts login claude --label personal
agentusage accounts list codex --json
agentusage daemon run
```

AgentStart owns the single `io.arthack.agentusage.observe` LaunchAgent. Its full
installer installs AgentUsage before AgentLaunch and converges that existing
service. Do not create another daemon per provider or native session. The binary
installer does not install providers or modify credentials.

Login runs the native OAuth flow in a private temporary home, imports the result,
and removes only that temporary state and its scoped Claude keychain item.
Claude import obtains the account UUID from the provider profile endpoint.
Native login output goes to stderr; account command envelopes never contain tokens.

For an explicit, private native credential file:

```sh
agentusage accounts import codex --file /private/path/auth.json --label work
agentusage accounts import claude --file /private/path/credentials.json
agentusage accounts login codex --account codex-1
agentusage accounts disable codex codex-1
agentusage accounts enable codex codex-1
agentusage accounts remove codex codex-1
```

Imports require a private regular file and parent directory owned by the user. Codex accepts native
`tokens` JSON with its account identity and JWT expiry; Claude accepts
`claudeAiOauth`. Reauthentication must retain the original provider identity.
Keys are stable `claude-N` and `codex-N`; removed numbers are never reused.
Account commands and `prepare --account` accept that key, the native account ID,
ordinal, email or label, and refuse ambiguous matches. `accounts list --json`
includes the nonsecret `account_id` so workspaces sharing an email can be
distinguished during enrollment. Codex observations expose the same identity as
`providerAccountId`; `balance codex --account` accepts it too.
No command discovers or parses an old swap store.

## Cutover

Follow the [coordinated cutover runbook](docs/CUTOVER.md). Land and validate
the AgentUsage, AgentLaunch, and AgentStart bundle together,
then converge installation last. Stop legacy sessions that own the credentials
being transferred before importing them, or use fresh native login. A copied
refresh token must never keep rotating in both an old process and AgentUsage.
Existing native session files can be resumed after onboarding without moving
them into per-account homes.

Old wrapper commands, checkouts, backups and credential stores are not deleted
by this bundle. They are no longer required by installation or runtime. Recreate
focus targets using the new stable account keys: the old sidecar schemas and
Claude route identities are replaced, not silently migrated. Grok is unchanged.

## Operator commands

```sh
agentusage                         # interactive usage viewer
agentusage usage --snapshot         # one frame
agentusage usage --json             # sidecars only
agentusage status --json
agentusage refresh claude           # observe now, respecting provider backoff
agentusage recover codex-1          # refresh an expired credential if recoverable
agentusage balance claude --model fable --dry-run --json
agentusage balance codex --model gpt-5.3-codex-spark --dry-run --json
agentusage focus set codex codex-2 permanent
agentusage focus set claude claude-1 current-reset
agentusage focus set fable claude-1 cycle-end
agentusage focus clear codex
```

`balance` keeps the existing headroom, Fable/non-Fable, focus/fallback, and Spark
lane behavior. Explicit pins are subject to the same eligibility checks. Codex
main selection applies five percentage points of pressure per active lease;
equal choices rotate. Spark uses its independent windows even when main quota
is exhausted. Reset credits are displayed, never spent automatically.

Provider focus takes precedence over Claude intent focuses. An unavailable
focused account falls back to other eligible accounts; an unavailable explicit
account pin refuses. Fable requires its additional model window; ordinary and
1M/Haiku models do not inherit Fable exhaustion. Stale or failed usage remains
visible as last-good data but cannot authorize selection.

## Launcher contract

```sh
agentusage prepare codex --json [--account codex-1] [--model MODEL] [--dry-run]
agentusage prepare claude --json [--account claude-1] [--model MODEL] [--dry-run]
```

Success is `{schema_version:1,ok:true,provider,account_key,reason,args,env,
unset_env,lease}`. A real lease contains `{id,token,url,expires_at_ms}`. Treat
this JSON as private process transport: do not log it or put the token in argv.
Refusal is `{schema_version:1,ok:false,provider,refusal,detail}` with nonzero exit.

Apply `unset_env`, then `env`, without changing either native home. Claude gets
its opaque OAuth bearer and loopback base URL. Codex gets a custom Responses
provider. Insert its `args` after native/resource options and before the first
literal `--`: current stock Codex discards global `-c` overrides when a
subcommand has local overrides. Resources also need the effective scope for
nested `exec resume`. Reject explicit conflicting provider/auth options before
preparing a lease. Utility invocations, including `codex app-server`, remain
native and bypass preparation.

Renew with `POST lease.url`, `Authorization: Bearer <token>`, every 25 seconds.
The response is `{schema_version:1,ok:true,account_key}`; `account_key` reports the
current assignment, which can differ from the initial selection for automatic
Codex sessions. Stop and await renewal before `DELETE` at failed spawn or exit.
HTTP calls must be bounded, loopback only, and refuse redirects. Cleanup of an
expired/already-released lease never changes native exit status. After sleep
past the 90-second TTL, the parent ends the native child and tells the operator
to resume; expired credentials cannot be revived.

Dry-run requires neither daemon liveness nor a reservation and emits no token.
AgentLaunch's human output is a credential-free AgentLaunch invocation that
prepares afresh. Its JSON `command` is the planned native argv;
`command_requires_prepare` and `reprepare_command` make that distinction explicit.

## Exhaustion and restart

Every resume selects again. The proxy also records confirmed Codex
`usage_limit_reached` HTTP 429 responses immediately as lane-specific cooldowns.
For an unpinned, self-contained Responses request, it can reassign the lease and
retry against another eligible account, with at most three account attempts.
It never retries across accounts for generic throttling, 5xx errors, disconnects,
timeouts, a `previous_response_id`, uploaded-object references, encrypted
reasoning, or a response already streaming. Explicit pins remain fixed. Parent renewal reports reassignment without changing the
native thread ID or history.

The daemon reuses its private endpoint and lease state on restart. Existing
streams can fail during restart; valid leases continue against the same account
or their last committed reassignment. The proxy serves Responses, not Realtime
or App Server. AgentVoice's native `codex app-server` path stays outside it.

## State and limits

All private JSON leaves use mode 0600, atomic fsynced replacement and kernel
flock. Reads refuse symlinks and group/other permissions. Account credentials
and last-good usage live in `accounts/pool.json`; only hashes of opaque session
credentials live in `service/leases.json`. `service/endpoint.json` holds the
stable listener port and private health credential. Default port: 43623 on
literal `127.0.0.1`; `AGENTUSAGE_PROXY_PORT` selects the initial port.

The proxy limits concurrent requests to 32, request bodies to 32 MiB, aggregate
request buffers to 128 MiB, headers/uploads to 90 seconds, idle streams to five
minutes and stream lifetime to one hour. Credential refresh retries once on a
401 against the same identity and adopts an already-refreshed generation when
concurrent requests race. A second 401 quarantines only the rejected generation
until reauthentication. Observation calls are paced and preserve last-good
measurements on invalid responses, network errors and Retry-After backoff.

`AGENTUSAGE_STATE_ROOT` isolates state for tests. Test provider-origin overrides
require that variable and a literal HTTP IPv4 loopback origin; production
provider origins are fixed.

## Validation

```sh
bun test
bun run typecheck
```

Fixtures never access real state or accounts. The bundle is also tested through
the installed native CLIs against a local synthetic upstream, covering common
history, profile/config/resource overlays, resume and opaque authentication.
Claude live subscription acceptance remains unavailable while the subscription
is inactive; local native transport acceptance is separate evidence.

Reproduce the native producer/consumer checks with [native acceptance](docs/NATIVE-ACCEPTANCE.md).

## Credits

The account implementation builds on codex-swap's behavior, Claude/Codex
protocol research from claude-swap, codex-multi-auth and OpenAI Codex, and the
original Keeper usage subsystem. [Source credits and upstream license
notices](THIRD_PARTY_NOTICES.md) record the authors, revisions and scope.
