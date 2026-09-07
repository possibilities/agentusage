# Account implementation credits and notices

The Claude/Codex account replacement draws on the projects below. Removing a
runtime dependency does not remove its provenance. This record distinguishes
adapted behavior from native protocol and source references; it does not claim
that entire upstream implementations were copied.

## Adapted behavior and protocol references

| Project and authors | Source reviewed | Contribution to AgentUsage |
| --- | --- | --- |
| [codex-swap](https://github.com/possibilities/codex-swap), Mike Bannister | [`b42753442384738c1cc33f458b31d288ee164b45`](https://github.com/possibilities/codex-swap/tree/b42753442384738c1cc33f458b31d288ee164b45), MIT | Account-selection behavior from `src/selection/selector.ts`, usage endpoints and 404-only fallback from `src/usage/direct-usage-probe.ts`, and usage-window/reset-credit contracts from `src/usage/parser.ts`. These inform `src/balance/codex.ts`, `src/accounts/usage.ts`, and `src/codex/observe.ts`, adapted to AgentUsage's pool, observations and leases. |
| [claude-swap](https://github.com/realiti4/claude-swap), Onur Cetinkol and contributors; integration work in [our fork](https://github.com/possibilities/claude-swap) | Integration revision [`f7385b7c5e19d0024d23e37b2634cf6a6b9aa01b`](https://github.com/possibilities/claude-swap/tree/f7385b7c5e19d0024d23e37b2634cf6a6b9aa01b), MIT | Reference for Claude OAuth client/endpoint/beta-header values, credential field names, usage windows and account-capacity metadata, especially `src/claude_swap/oauth.py` and `credentials.py`. AgentUsage implements its own TypeScript HTTP, storage and refresh path in `src/accounts/` and normalization in `src/claude/observe.ts`. |
| [codex-multi-auth](https://github.com/ndycode/codex-multi-auth), ndycode and contributors | Version `2.10.0`, MIT, as pinned by codex-swap | Reference for Codex OAuth/token and ChatGPT header conventions in `lib/auth/auth.ts` and `lib/constants.ts`, reflected in `src/accounts/credentials.ts` and `store.ts`. Its account manager, rotation proxy and refresh guardian are not bundled or imported. |
| [OpenAI Codex](https://github.com/openai/codex), OpenAI and contributors | [`112be0bd74ce327788613f4f8f92e8b7c92447c7`](https://github.com/openai/codex/tree/112be0bd74ce327788613f4f8f92e8b7c92447c7), Apache-2.0 | Source reference for native auth/storage/refresh behavior in `codex-rs/login/src/auth/{manager,storage,external_bearer}.rs` and native config handling. This informed the shared-proxy design and the compatibility proofs in `docs/NATIVE-ACCEPTANCE.md`. No Codex Rust implementation is vendored here. |

The original Keeper usage subsystem supplied the Claude observation-v7 schema,
freshness vocabulary, balance policy and focus contract retained in
`src/claude/types.ts`, `src/constants.ts`, `src/balance/claude.ts` and
`src/focus.ts`. [The original build sketch](docs/SKETCH.md) records that lineage;
the account-ownership replacement does not erase it.

The shared daemon, private prepare envelope, opaque lease transport, refresh
ownership, bounded quota reassignment and AgentLaunch integration are maintained
in this fleet. Native Codex CLI `0.153.4` acceptance is test evidence, distinct
from the source revision credited above.

## License copies

These retain the reviewed upstream license texts verbatim, with line endings
normalized to LF:

- [claude-swap MIT license](LICENSES/claude-swap-MIT.txt), copyright 2026 Onur Cetinkol.
- [codex-multi-auth MIT license](LICENSES/codex-multi-auth-MIT.txt), copyright 2026 ndycode.
- [codex-swap MIT license](LICENSES/codex-swap-MIT.txt), copyright 2026 Mike Bannister.
- [OpenAI Codex Apache-2.0 license](LICENSES/openai-codex-Apache-2.0.txt), copyright 2025 OpenAI, and its [upstream NOTICE](LICENSES/openai-codex-NOTICE.txt).

The Codex NOTICE is retained verbatim as source-reference provenance; its
Ratatui attribution describes Codex's upstream contents, not code incorporated
into AgentUsage. Package dependencies retain their own licenses. AgentUsage's
[MIT license](LICENSE) covers this repository's original work; it does not
replace the upstream notices above.
