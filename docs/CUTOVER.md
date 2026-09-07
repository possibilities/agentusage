# Coordinated account cutover

This is a runbook for the landing coordinator, not a completed migration.
Source-linked CLIs execute canonical source immediately: moving main is already
runtime deployment. The tested bundle alone does not enroll production accounts.
Do not promote it during the separately owned codex-swap session migration.

## Before runtime promotion

1. Obtain the coordinator’s migration-complete receipt and exclusive runtime
   convergence window. Preserve the landed guidance footers and all AgentStart
   watcher/Ghostty changes. Review one tested commit per repository.
2. Record every retained explicit selector, its old provider/account identity,
   and the expected new key/label. Include workspace distinctions when emails
   are shared. The candidate's `accounts list --json` exposes `account_id` for
   this comparison; native account IDs remain valid explicit pins. Old
   swap-internal record keys must be translated to the mapped owned key or
   native identity before reusing a saved invocation. Enroll fresh native
   OAuth grants in a private candidate state root using the candidate binary.
   This lets existing native/swap sessions retain their original grants and
   homes. Native sign-in may require the operator. If transferring an existing
   credential instead, its legacy refresh owners must first be positively
   identified and stopped by their owner; a copied rotating token cannot have
   two refresh owners. Do not bulk-kill sessions or inspect legacy store files.

```sh
usage_candidate=/path/to/agentusage
candidate_state=$(mktemp -d "$HOME/.local/state/agentusage-candidate.XXXXXX")
chmod 700 "$candidate_state"
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" accounts login codex --device-auth --label work
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" accounts login claude --label personal
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" accounts list codex --json
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" accounts list claude --json
```

3. Start the candidate’s **one** daemon in a managed foreground terminal with
   that same `AGENTUSAGE_STATE_ROOT` and an available loopback port, e.g.
   `AGENTUSAGE_PROXY_PORT=43623 bun "$usage_candidate/src/cli.ts" daemon run`.
   Set the state-root variable on this command too. No launchd registration or
   installed command changes yet. The old observer still uses its original
   root; the candidate observations cannot overwrite its sidecars.
4. In another terminal, use the same state root for these public checks:

```sh
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" daemon status
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" prepare codex --dry-run --json
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" prepare claude --dry-run --json
AGENTUSAGE_STATE_ROOT="$candidate_state" bun "$usage_candidate/src/cli.ts" prepare codex --account codex-1 --dry-run --json
```

`daemon status` must print `ready` (authenticated loopback health plus fresh
sidecars). Each intended balanced provider and explicit pin must return
`ok:true` and the expected `account_key`, with `lease:null`. Repeat the pinned
check for **every retained explicit pin** in the recorded old-to-new identity
mapping; `codex-1` above is only an example. A missing/inactive
subscription is a real refusal, not readiness: preserve native authentication
for that provider through the existing AgentLaunch balance configuration until
it can be enrolled and observed. Do not claim live Claude subscription
acceptance from the mock tests.

5. Validate the exact producer/consumer commit pair with
   [native acceptance](NATIVE-ACCEPTANCE.md). Its temporary homes, fake grants,
   zero remaining leases and removed listeners are a separate reproducible
   check; they do not establish production enrollment.

## The serialized runtime window

The coordinator must hold **all new balanced launches and resumes** from the
first observer stop until final-root readiness is verified below. This includes
bare harness shims, AgentLaunch, and surface-created sessions. Notify their
owners before the window and release the hold explicitly afterward; source
promotion and service startup are not an atomic operation. Existing native
sessions keep running under their current owner.

Stop and await the candidate test daemon and the old observer service before
switching observation ownership. Transfer
only the candidate’s owned `accounts/` directory to the final private
`~/.local/state/agentusage/accounts/` path, while both relevant account locks are
free and **only if the destination is absent**. Preserve its private modes.
If a destination pool already exists, stop and reconcile identities using the
account CLI; never overwrite or merge credential JSON by hand. This is a move
of newly owned enrollment state, not a second copy of a legacy rotating grant.
Do not transfer temporary leases, endpoint secrets or mock observations.

Promote AgentUsage → AgentLaunch → AgentStart in the reserved window. Run each
repository’s supported binary installer, then AgentStart’s supported convergence
last. This starts the existing `io.arthack.agentusage.observe` service with its
owned pool and removes the old provider environment pins. Do not delete old
wrapper commands, checkouts, backups or credentials. Existing processes that
still use them finish under their own owner’s plan.

Keep new launches held after the source commits land. Candidate-root readiness
is not evidence of final-root readiness: with the normal production environment
(no candidate `AGENTUSAGE_STATE_ROOT` override), verify installed command
resolution to the three canonical checkouts, `agentusage daemon status` at the
final endpoint, and automatic plus every mapped explicit pin’s
`prepare --dry-run`. Require `ready`, `ok:true`, the expected mapped account key,
and `lease:null` for every intended balanced provider. Also verify
AgentLaunch’s credential-free human dry-run, the rendered observer plist without
both swap environment pins, and common native history/resume. Any deliberate
live session smoke must use an eligible account and release its lease on exit.
Only after these final-root checks may the coordinator release new balanced
launches/resumes and start an intentional live smoke. A service restart keeps
valid leases only when their endpoint/state is retained;
expired leases require native resume. Recreate focus policies using the new
account keys rather than copying obsolete sidecar identities.

Record the exact installed SHAs, account identity mapping (no credentials),
readiness results, process/service cleanup and any provider intentionally left
on native authentication. If a precondition is missing, keep runtime source
promotion held; the committed implementation remains reviewable and ready.
