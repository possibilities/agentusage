# Account decisions and current contracts

- [Account ownership in AgentUsage](../ACCOUNT-OWNERSHIP.md) is the approved
  Claude/Codex ownership and native-home/proxy design. It supersedes the
  ownership and launcher sections of [the earlier sketch](../SKETCH.md).
- [0001: Own Grok's account lifecycle](0001-own-grok-account-lifecycle.md)
  records the subsequent Grok extension and its explicit snapshot-transfer
  boundary. It supersedes the sketch's Grok subprocess/provider ownership.
- [0002: Audit supplied Codex catalog and quota evidence](0002-audit-supplied-codex-catalog-evidence.md)
  keeps reviewed guidance, native capabilities and quota observations distinct
  in an offline diagnostic without changing selection or account activation.
- [0003: Collect versioned native catalogs](0003-collect-versioned-native-catalogs.md)
  adds an explicit owned stdio collector with fake-protocol validation and
  checked pagination receipts; it does not change the offline audit or routing.
- [0007: Interpret an omitted Grok credits percentage as zero](0007-interpret-omitted-grok-credit-percent-as-zero.md)
  makes a complete modern unified-billing period with an omitted proto3 usage
  scalar decision-grade as 0% used, while ambiguous response shapes remain
  unknown.
- The sketch's viewer and focus-policy contracts remain applicable; its swap
  examples are historical wherever the documents above replace them.

Read [CONTEXT.md](../../CONTEXT.md) for provider observations, selection and
lease terms, and [README.md](../../README.md) for the current operator/launcher
contract. Add a new record when the choice changes rather than copying the
accepted ownership rationale into another parallel specification.

- [0017: Retire AgentFX routing integration](0017-retire-agentfx-routing-integration.md)
  removes the AgentFX bridge, manager routing projections, and Grok model-catalog
  capture while preserving ordinary provider ownership and observation. It
  supersedes ADRs 0004–0006, 0008, and 0009–0016.
- [0018: Refresh Codex workspace names from accounts/check](0018-refresh-codex-workspace-names.md)
  observes the current ChatGPT workspace name during Codex usage refresh so the
  TUI follows provider-side renames instead of frozen import labels.

ADRs 0004–0006, 0008, and 0009–0016 remain as historical records of the retired
integration. They are not current contracts.
