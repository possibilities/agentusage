# 0020: Observe Devin usage from the native CLI login

Status: Accepted 2026-09-22 at the operator's request.

## Context

The Devin CLI keeps a single local login in `credentials.toml` under its data
home: an API key plus that login's seat-management server. Its account-level
quota — plan label, daily and weekly remaining percentages with reset times,
the billing cycle, prompt-credit counters, and a weekly-quota visibility flag —
is reported by `SeatManagementService/GetUserStatus` as bounded Connect JSON.
There is no Devin CLI usage subcommand and no fleet helper to delegate to the
way `agentgrok usage` serves the Grok Bot card.

## Decision

Observe Devin as its own display sidecar, `devin/observation.json`, by reading
the native credential file in place and POSTing the Connect JSON call to the
credential's own `api_server_url` (`AGENTUSAGE_TEST_DEVIN_ORIGIN` provides the
IPv4 loopback fixture origin, and `AGENTUSAGE_DEVIN_CREDENTIALS` the fixture
login). Persist only the allowlisted plan label, billing strategy, quota
percents, reset times, billing cycle, credit counters, visibility flag, and
account display name. Drop every URL, id, and email. Fixed error text replaces
upstream messages. A failed read keeps the last good quota and marks it stale;
a missing credential file reports `absent`.

The viewer adds one card named `devin-1`. It is not a managed account, not
part of selection, balance, focus, or prepare, and not required for daemon
liveness. `agentusage refresh devin` and refresh `all` publish it. The daemon
observer polls it on the same interval as the other providers.

## Consequences

The card follows whichever login the Devin CLI uses; AgentUsage reads the
credential where the vendor wrote it — under vendor-chosen permissions — and
never copies it into state, logs it, or puts it in argv. A Connect schema
change or a credential-file format change breaks this card. Devin has no
multi-account inventory here; there is nothing to balance.
