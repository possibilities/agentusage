# 0019: Observe Grok Bot usage separately from Grok billing

Status: Accepted 2026-09-22 at the operator's request.

## Context

AgentUsage already shows Grok included allowance, prepaid balance, and
pay-as-you-go from `GET /v1/billing?format=credits` on the owned Grok
inventory. That meter is not Grok Bot usage. A live `bot.usage` read on the
xAI Computer Hub returned a different weekly percent, a different period, and
a plan label, while the owned billing account sat at 0%.

AgentGrok already calls that verb with `agentgrok usage --json`. The hub
once refused it as `not_yet_enabled`; it now returns an untyped object that
includes a manage URL carrying an account id.

## Decision

Observe Grok Bot as its own display sidecar, `grok-bot/observation.json`,
by running `agentgrok usage --json` (or `AGENTUSAGE_GROK_BOT_BIN` in tests).
Persist only the allowlisted percent, period, plan label, funding plan, and
on-demand/trial/team flags. Drop every URL and every other string. Fixed
error text replaces upstream messages. A failed read keeps the last good
percent and marks it stale.

The viewer adds one card named Grok Bot. It is not a managed account, not
part of Grok selection or balance, and not required for daemon liveness.
`agentusage refresh grok-bot` and refresh `all` publish it. The daemon
observer polls it on the same interval as the other providers.

## Consequences

The card follows whichever login the grok CLI session uses, not
`accounts/grok.json`. Changing AgentGrok's usage envelope or dropping
`bot.usage` breaks this card. The owned Grok billing card is unchanged.
