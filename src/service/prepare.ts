import type { StatePaths } from '../paths.ts';
import { AccountError, nonempty } from '../accounts/storage.ts';
import {
  findAccount,
  readPool,
  type ManagedProvider,
} from '../accounts/store.ts';
import type { Env } from '../accounts/http.ts';
import { buildObservation } from '../claude/observe.ts';
import { selectClaudeRoute } from '../balance/claude.ts';
import { buildCodexObservation } from '../codex/observe.ts';
import { chooseCodexWithLeases } from '../balance/codex.ts';
import {
  readClaudeObservation,
  readCodexObservation,
  refreshClaudeObservation,
  refreshCodexObservation,
} from '../observe.ts';
import { effectiveCodexFullFocus, readFullFocusLeaf } from '../focus.ts';
import {
  changeLeases,
  issueLease,
  leaseToken,
  readLeases,
  type LeaseState,
} from './leases.ts';
import {
  DEFAULT_PROXY_PORT,
  endpointURL,
  readEndpoint,
  readyEndpoint,
} from './proxy.ts';

export interface PreparedLaunch {
  provider: ManagedProvider;
  account_key: string;
  reason: string;
  args: string[];
  env: Record<string, string>;
  unset_env: string[];
  lease: {
    id: string;
    token: string;
    url: string;
    expires_at_ms: number;
  } | null;
}
export async function prepareLaunch(
  paths: StatePaths,
  provider: ManagedProvider,
  options: { account?: string; model?: string; dryRun?: boolean },
  env: Env = process.env,
): Promise<PreparedLaunch> {
  if (options.account !== undefined && !nonempty(options.account))
    throw new AccountError(
      'invalid-account',
      'An explicit account pin must be nonempty',
    );
  if (options.model !== undefined && !nonempty(options.model))
    throw new AccountError(
      'invalid-model',
      'A requested model must be nonempty',
    );
  const endpoint = options.dryRun
    ? readEndpoint(paths)
    : await readyEndpoint(paths);
  const url = endpoint
    ? endpointURL(endpoint)
    : `http://127.0.0.1:${DEFAULT_PROXY_PORT}`;
  let claude = readClaudeObservation(paths),
    codex = readCodexObservation(paths);
  if (!options.dryRun) {
    if (provider === 'claude')
      claude = (await refreshClaudeObservation(paths, { env })).value;
    else codex = (await refreshCodexObservation(paths, { env })).value;
  }
  const create = (state: LeaseState): PreparedLaunch => {
    let key: string, reason: string;
    // Resolve labels/emails at the account boundary, before applying policy gates.
    const requested =
      options.account !== undefined
        ? findAccount(readPool(paths), provider, options.account).key
        : undefined;
    if (provider === 'claude') {
      if (!claude)
        throw new AccountError(
          'observation-unavailable',
          'No Claude observation; refresh accounts first',
          503,
        );
      const selection = selectClaudeRoute({
        paths,
        observation: buildObservation(readPool(paths).accounts, Date.now()),
        model: options.model,
        requestedRoute: requested,
        dryRun: options.dryRun ?? false,
      });
      if (!selection.ok)
        throw new AccountError(selection.refusal, selection.detail, 409);
      key = selection.route.id;
      reason = selection.reason;
    } else {
      const focus = effectiveCodexFullFocus(
        readFullFocusLeaf(paths.codexFullFocusLeaf, 'codex'),
        codex,
        Date.now(),
      );
      const target =
        focus.state === 'active' ? (focus.policy?.target ?? null) : null;
      const selection = chooseCodexWithLeases(
        buildCodexObservation(readPool(paths).accounts, Date.now()),
        options.model && /spark/iu.test(options.model) ? 'codex-spark' : 'main',
        { account: requested },
        state,
        target,
      );
      if (!selection.ok)
        throw new AccountError(selection.refusal, selection.detail, 409);
      key = selection.accountKey;
      reason = selection.reason;
    }
    const account = findAccount(readPool(paths), provider, key);
    if (!account.enabled || account.auth_error)
      throw new AccountError(
        'account-unavailable',
        'Selected account is disabled or requires login',
        409,
      );
    const issued = options.dryRun
      ? null
      : issueLease(state, provider, key, Date.now(), {
          pinned: options.account !== undefined,
          model: options.model,
        });
    const token = issued ? leaseToken(issued) : '';
    const args =
      provider === 'codex'
        ? [
            '-c',
            'model_provider="agentusage"',
            '-c',
            `model_providers.agentusage={name="AgentUsage",base_url="${url}/codex",env_key="AGENTUSAGE_AUTH_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
          ]
        : [];
    return {
      provider,
      account_key: key,
      reason,
      args,
      env: options.dryRun
        ? { AGENTUSAGE_ACCOUNT: key }
        : provider === 'codex'
          ? { AGENTUSAGE_ACCOUNT: key, AGENTUSAGE_AUTH_TOKEN: token }
          : {
              AGENTUSAGE_ACCOUNT: key,
              AGENTUSAGE_AUTH_TOKEN: token,
              CLAUDE_CODE_OAUTH_TOKEN: token,
              ANTHROPIC_BASE_URL: `${url}/claude`,
            },
      unset_env:
        provider === 'codex'
          ? [
              'CODEX_API_KEY',
              'CODEX_ACCESS_TOKEN',
              'OPENAI_API_KEY',
              'CODEX_MULTI_AUTH_DIR',
            ]
          : [
              'ANTHROPIC_API_KEY',
              'ANTHROPIC_AUTH_TOKEN',
              'CLAUDE_CODE_USE_BEDROCK',
              'CLAUDE_CODE_USE_VERTEX',
              'CLAUDE_CODE_USE_FOUNDRY',
            ],
      lease: issued
        ? {
            id: issued.leaseId,
            token,
            url: `${url}/lease`,
            expires_at_ms: Date.parse(issued.expiresAt),
          }
        : null,
    };
  };
  return options.dryRun
    ? create(readLeases(paths))
    : changeLeases(paths, create);
}
