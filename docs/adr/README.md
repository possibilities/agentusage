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
- [0004: Own Fx credential-broker authority](0004-own-fx-credential-broker-authority.md)
  defines the generation-pinned lease, private capability handoff and mediated
  provider-request boundary. Real account adapters remain disabled.
- The sketch's viewer and focus-policy contracts remain applicable; its swap
  examples are historical wherever the documents above replace them.

Read [CONTEXT.md](../../CONTEXT.md) for provider observations, selection and
lease terms, and [README.md](../../README.md) for the current operator/launcher
contract. Add a new record when the choice changes rather than copying the
accepted ownership rationale into another parallel specification.
