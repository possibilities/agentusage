# 0010: Publish bounded manager economics

Status: Accepted

## Context

The native manager context already joins fresh Codex and Grok quota evidence,
but its reviewed guidance reports all economics as unavailable. That prevents a
manager from distinguishing the current Codex models by cost even though the
official OpenAI API catalog publishes a stable ordering for their text-token
prices. Grok included allowance and Codex subscription quota are different
products, so those API prices cannot establish a numeric cross-provider ratio or
exact subscription consumption.

## Decision

The reviewed native-manager catalog records the official OpenAI API text input
and output prices observed on 2026-09-16 from each model's page under
<https://developers.openai.com/api/docs/models>. Each row carries its exact
source URL, is explicitly scoped to `within_provider`, uses USD per million text
tokens, and states that subscription-quota equivalence is unavailable. The
current ordering is Luna, Terra, Sol, GPT-5.5, then Astra; both published input
and output prices have that same order.

The routing policy chooses the least expensive reviewed Codex model adequate for
the task. Separately, it prefers an eligible included-allowance Grok target when
the target advertises compatible capabilities, to preserve finite Codex main
quota. This is a quota-stewardship preference, not a price comparison. Exact
AgentFX target capability and fresh source revision remain dispatch-time gates.

Catalog drift disables both the model table and the policy. The snapshot keeps
cross-provider economics explicitly unavailable and never converts API token
prices into subscription quota, predicted task cost, or a provider exchange
rate.

## Consequences

Existing schema-2 snapshots remain valid. The economics and policy fields are
an additive native-manager extension accepted by AgentHUD. AgentVoice delivers
the policy as background routing orientation; it still does not select an
account, refresh a provider, dispatch work, or claim manager consumption.
