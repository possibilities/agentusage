import { join } from 'node:path';
import type { StatePaths } from '../paths.ts';
import {
  AccountError,
  checkPrivateDirectory,
  nonempty,
  privateDirectory,
  readPrivate,
  record,
  withLock,
  writePrivate,
} from './storage.ts';

export type ManagedProvider = 'claude' | 'codex';
export interface Credentials {
  access_token: string;
  refresh_token: string | null;
  expires_at_ms: number;
  generation: number;
}
export interface UsageSample {
  measured_at_ms: number;
  value: Record<string, unknown>;
}
export interface ManagedAccount {
  key: string;
  provider: ManagedProvider;
  ordinal: number;
  email: string | null;
  label: string | null;
  account_id: string;
  enabled: boolean;
  auth_error: string | null;
  credentials: Credentials;
  subscription_type: string | null;
  rate_limit_multiplier: 1 | 5 | 20 | null;
  usage: UsageSample | null;
  usage_error: { code: string; status: number | null } | null;
  next_poll_at_ms: number;
  refresh_after_ms: number;
  last_selected_at_ms: number;
  quota_blocks: Record<string, number>;
}
export interface AccountPool {
  schema_version: 1;
  next_ordinal: Record<ManagedProvider, number>;
  accounts: ManagedAccount[];
}
const emptyPool = (): AccountPool => ({
  schema_version: 1,
  next_ordinal: { claude: 1, codex: 1 },
  accounts: [],
});
export const accountDirectory = (paths: StatePaths): string =>
  join(paths.stateRoot, 'accounts');
export const accountFile = (paths: StatePaths): string =>
  join(accountDirectory(paths), 'pool.json');
export const accountLock = (paths: StatePaths): string =>
  join(accountDirectory(paths), 'pool.lock');

function validatePool(value: unknown): AccountPool {
  const p = record(value);
  const n = record(p?.next_ordinal);
  if (
    p?.schema_version !== 1 ||
    !Array.isArray(p.accounts) ||
    p.accounts.length > 100 ||
    !n ||
    !['claude', 'codex'].every(
      (k) => Number.isSafeInteger(n[k]) && Number(n[k]) > 0,
    )
  )
    throw new AccountError('invalid-state', 'Invalid account pool');
  const keys = new Set<string>();
  const identities = new Set<string>();
  const nullableText = (x: unknown) => x === null || nonempty(x);
  const time = (x: unknown) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  for (const a of p.accounts) {
    const x = record(a),
      c = record(x?.credentials);
    if (
      !x ||
      !c ||
      (x.provider !== 'claude' && x.provider !== 'codex') ||
      !nonempty(x.key) ||
      !/^(claude|codex)-[1-9]\d*$/u.test(x.key) ||
      !Number.isSafeInteger(x.ordinal) ||
      Number(x.ordinal) < 1 ||
      x.key !== `${x.provider}-${x.ordinal}` ||
      keys.has(x.key) ||
      !nonempty(x.account_id) ||
      typeof x.enabled !== 'boolean' ||
      !nonempty(c.access_token) ||
      !(c.refresh_token === null || nonempty(c.refresh_token)) ||
      typeof c.expires_at_ms !== 'number' ||
      !Number.isFinite(c.expires_at_ms) ||
      !Number.isSafeInteger(c.generation)
    )
      throw new AccountError('invalid-state', 'Invalid account record');
    keys.add(x.key);
    const identity = `${x.provider}:${x.account_id}`;
    const usage = x.usage === null ? null : record(x.usage);
    const issue = x.usage_error === null ? null : record(x.usage_error);
    if (
      identities.has(identity) ||
      Number(n[x.provider]) <= Number(x.ordinal) ||
      !nullableText(x.email) ||
      !nullableText(x.label) ||
      !nullableText(x.auth_error) ||
      !nullableText(x.subscription_type) ||
      ![null, 1, 5, 20].includes(x.rate_limit_multiplier as number | null) ||
      ![x.next_poll_at_ms, x.refresh_after_ms, x.last_selected_at_ms].every(
        time,
      ) ||
      Number(c.generation) < 1 ||
      !time(c.expires_at_ms) ||
      (x.usage !== null &&
        (!usage || !time(usage.measured_at_ms) || !record(usage.value))) ||
      (x.usage_error !== null &&
        (!issue ||
          !nonempty(issue.code) ||
          !(
            issue.status === null ||
            (Number.isInteger(issue.status) &&
              Number(issue.status) >= 100 &&
              Number(issue.status) <= 599)
          )))
    )
      throw new AccountError('invalid-state', 'Invalid account metadata');
    identities.add(identity);
    if (
      !record(x.quota_blocks) ||
      Object.entries(x.quota_blocks as object).some(
        ([lane, until]) =>
          !['main', 'codex-spark'].includes(lane) || !time(until),
      )
    )
      throw new AccountError('invalid-state', 'Invalid quota cooldown');
  }
  return value as AccountPool;
}
export function readPool(paths: StatePaths): AccountPool {
  checkPrivateDirectory(paths.stateRoot);
  // Absence is an empty inventory, never a fallback to a harness or swap store.
  return readPrivate(accountFile(paths), validatePool, emptyPool);
}
export async function changePool<T>(
  paths: StatePaths,
  fn: (pool: AccountPool) => T | Promise<T>,
): Promise<T> {
  privateDirectory(paths.stateRoot);
  return withLock(accountLock(paths), async () => {
    const pool = readPool(paths);
    const result = await fn(pool);
    validatePool(pool);
    writePrivate(accountFile(paths), pool);
    return result;
  });
}
export function findAccount(
  pool: AccountPool,
  provider: ManagedProvider,
  selector: string,
): ManagedAccount {
  const candidates = pool.accounts.filter(
    (a) =>
      a.provider === provider &&
      (a.key === selector ||
        a.account_id === selector ||
        String(a.ordinal) === selector ||
        a.email === selector ||
        a.label === selector),
  );
  if (candidates.length !== 1)
    throw new AccountError(
      'account-not-found',
      'Account selector must resolve to exactly one managed account',
      404,
    );
  return candidates[0]!;
}
export function publicAccount(a: ManagedAccount) {
  return {
    key: a.key,
    provider: a.provider,
    account_id: a.account_id,
    ordinal: a.ordinal,
    email: a.email,
    label: a.label,
    enabled: a.enabled,
    auth_error: a.auth_error,
    expires_at_ms: a.credentials.expires_at_ms,
    usage_error: a.usage_error,
  };
}
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    return (
      record(
        JSON.parse(
          Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
        ),
      ) ?? {}
    );
  } catch {
    return {};
  }
}
export function parseCredentials(
  provider: ManagedProvider,
  value: unknown,
): {
  credentials: Credentials;
  account_id: string;
  email: string | null;
  subscription_type: string | null;
  rate_limit_multiplier: 1 | 5 | 20 | null;
} {
  const root = record(value);
  if (!root)
    throw new AccountError(
      'invalid-credentials',
      'Expected native OAuth credential JSON',
    );
  const raw =
    provider === 'claude'
      ? (record(root.claudeAiOauth) ?? root)
      : (record(root.tokens) ?? root);
  const access = raw.access_token ?? raw.accessToken;
  const refresh = raw.refresh_token ?? raw.refreshToken ?? null;
  if (!nonempty(access) || !(refresh === null || nonempty(refresh)))
    throw new AccountError(
      'invalid-credentials',
      'OAuth access token and optional refresh token must be nonempty strings',
    );
  const claims = jwtClaims(access);
  const identityClaims =
    typeof raw.id_token === 'string' ? jwtClaims(raw.id_token) : claims;
  const openai =
    record(identityClaims['https://api.openai.com/auth']) ??
    record(claims['https://api.openai.com/auth']) ??
    {};
  const accountId =
    raw.account_id ??
    root.account_id ??
    openai.chatgpt_account_id ??
    root.accountId;
  if (
    provider === 'codex' &&
    nonempty(openai.chatgpt_account_id) &&
    accountId !== openai.chatgpt_account_id
  )
    throw new AccountError(
      'identity-mismatch',
      'Imported credential conflicts with its account identity',
    );
  const expires =
    raw.expires_at_ms ??
    raw.expiresAt ??
    (typeof claims.exp === 'number' ? claims.exp * 1000 : null);
  if (!nonempty(accountId) || accountId.length > 256)
    throw new AccountError(
      'invalid-credentials',
      'An account_id is required (Claude imports can wrap claudeAiOauth with account_id)',
    );
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0)
    throw new AccountError(
      'invalid-credentials',
      'Credential expiry must be epoch milliseconds or a JWT exp',
    );
  const email = root.email ?? identityClaims.email ?? claims.email;
  const subscription =
    raw.subscriptionType ?? root.subscription_type ?? openai.chatgpt_plan_type;
  const multiplier = raw.rateLimitMultiplier ?? root.rate_limit_multiplier;
  return {
    credentials: {
      access_token: access,
      refresh_token: refresh as string | null,
      expires_at_ms: expires,
      generation: 1,
    },
    account_id: accountId,
    email: nonempty(email) ? email : null,
    subscription_type: nonempty(subscription) ? subscription : null,
    rate_limit_multiplier:
      multiplier === 1 || multiplier === 5 || multiplier === 20
        ? multiplier
        : null,
  };
}
export async function importAccount(
  paths: StatePaths,
  provider: ManagedProvider,
  value: unknown,
  options: { label?: string; account?: string } = {},
): Promise<ReturnType<typeof publicAccount>> {
  const parsed = parseCredentials(provider, value);
  return changePool(paths, (pool) => {
    const existing =
      options.account !== undefined
        ? findAccount(pool, provider, options.account)
        : pool.accounts.find(
            (a) =>
              a.provider === provider && a.account_id === parsed.account_id,
          );
    if (existing && existing.account_id !== parsed.account_id)
      throw new AccountError(
        'identity-mismatch',
        'Reauthentication must keep the same account identity',
      );
    if (existing) {
      Object.assign(existing, parsed, {
        credentials: {
          ...parsed.credentials,
          generation: existing.credentials.generation + 1,
        },
        auth_error: null,
        refresh_after_ms: 0,
        next_poll_at_ms: 0,
      });
      if (options.label !== undefined) existing.label = options.label;
      return publicAccount(existing);
    }
    if (pool.accounts.length >= 100)
      throw new AccountError(
        'account-limit',
        'At most 100 managed accounts are supported',
      );
    const ordinal = pool.next_ordinal[provider]++;
    const account: ManagedAccount = {
      ...parsed,
      provider,
      ordinal,
      key: `${provider}-${ordinal}`,
      label: options.label ?? null,
      enabled: true,
      auth_error: null,
      usage: null,
      usage_error: null,
      next_poll_at_ms: 0,
      refresh_after_ms: 0,
      last_selected_at_ms: 0,
      quota_blocks: {},
    };
    pool.accounts.push(account);
    return publicAccount(account);
  });
}
