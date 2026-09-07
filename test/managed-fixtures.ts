import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'bun:test';
import { statePaths } from '../src/paths.ts';
import {
  changePool,
  type ManagedAccount,
  type ManagedProvider,
} from '../src/accounts/store.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
export function fixtureState() {
  const root = mkdtempSync(join(tmpdir(), 'agentusage-owned-test-'));
  roots.push(root);
  const env = { AGENTUSAGE_STATE_ROOT: root };
  return { root, env, paths: statePaths(env) };
}
export function claudeUsage(used = 20) {
  return {
    five_hour: {
      utilization: used,
      resets_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    seven_day: {
      utilization: used,
      resets_at: new Date(Date.now() + 86400_000).toISOString(),
    },
    seven_day_fable: {
      utilization: 30,
      resets_at: new Date(Date.now() + 86400_000).toISOString(),
    },
  };
}
export function codexUsage(used = 20, sparkUsed = 40) {
  const window = (pct: number, seconds: number) => ({
    used_percent: pct,
    limit_window_seconds: seconds,
    reset_at: Math.floor(Date.now() / 1000) + seconds,
  });
  return {
    plan_type: 'plus',
    rate_limit: {
      limit_reached: used >= 100,
      primary_window: window(used, 18000),
      secondary_window: window(used, 604800),
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: window(sparkUsed, 18000),
          secondary_window: window(sparkUsed, 604800),
        },
      },
    ],
  };
}
export function managed(
  provider: ManagedProvider = 'codex',
  ordinal = 1,
  overrides: Partial<ManagedAccount> = {},
): ManagedAccount {
  return {
    key: `${provider}-${ordinal}`,
    provider,
    ordinal,
    email: `${provider}${ordinal}@example.test`,
    label: null,
    account_id: `identity-${provider}-${ordinal}`,
    enabled: true,
    auth_error: null,
    credentials: {
      access_token: `access-${provider}-${ordinal}`,
      refresh_token: `refresh-${provider}-${ordinal}`,
      expires_at_ms: Date.now() + 3600_000,
      generation: 1,
    },
    subscription_type: provider === 'claude' ? 'max' : 'plus',
    rate_limit_multiplier: provider === 'claude' ? 20 : null,
    usage: {
      measured_at_ms: Date.now(),
      value: provider === 'claude' ? claudeUsage() : codexUsage(),
    },
    usage_error: null,
    next_poll_at_ms: Date.now() + 180_000,
    refresh_after_ms: 0,
    last_selected_at_ms: 0,
    quota_blocks: {},
    ...overrides,
  };
}
export async function seed(
  state: ReturnType<typeof fixtureState>,
  accounts: ManagedAccount[],
) {
  await changePool(state.paths, (pool) => {
    pool.accounts = accounts;
    for (const provider of ['claude', 'codex'] as const)
      pool.next_ordinal[provider] =
        Math.max(
          0,
          ...accounts
            .filter((a) => a.provider === provider)
            .map((a) => a.ordinal),
        ) + 1;
  });
}
