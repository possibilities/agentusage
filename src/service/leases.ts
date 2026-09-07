import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { join } from 'node:path';
import type { StatePaths } from '../paths.ts';
import {
  AccountError,
  checkPrivateDirectory,
  privateDirectory,
  readPrivate,
  record,
  nonempty,
  withLock,
  writePrivate,
} from '../accounts/storage.ts';
import type { ManagedProvider } from '../accounts/store.ts';

export const LEASE_TTL_MS = 90_000;
export interface SessionLease {
  id: string;
  token_hash: string;
  account_key: string;
  provider: ManagedProvider;
  created_at_ms: number;
  expires_at_ms: number;
  pinned: boolean;
  model: string | null;
}
export interface LeaseState {
  schema_version: 1;
  leases: SessionLease[];
  last_selected: Record<string, string>;
}
export interface IssuedLease {
  leaseId: string;
  ownerNonce: string;
  accountKey: string;
  expiresAt: string;
}
export const serviceDirectory = (paths: StatePaths) =>
  join(paths.stateRoot, 'service');
const leaseFile = (paths: StatePaths) =>
  join(serviceDirectory(paths), 'leases.json');
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function validate(value: unknown): LeaseState {
  const s = record(value);
  if (
    s?.schema_version !== 1 ||
    !Array.isArray(s.leases) ||
    s.leases.length > 1024 ||
    !record(s.last_selected)
  )
    throw new AccountError('invalid-state', 'Invalid session lease store');
  const seen = new Set<string>();
  const validKey = (provider: unknown, key: unknown) =>
    typeof key === 'string' &&
    new RegExp(`^${provider}-[1-9]\\d*$`, 'u').test(key);
  for (const [provider, key] of Object.entries(
    s.last_selected as Record<string, unknown>,
  )) {
    if (
      (provider !== 'claude' && provider !== 'codex') ||
      !validKey(provider, key)
    )
      throw new AccountError('invalid-state', 'Invalid last selected account');
  }
  for (const value of s.leases) {
    const l = record(value);
    if (
      !l ||
      typeof l.id !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(l.id) ||
      seen.has(l.id) ||
      typeof l.token_hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(l.token_hash) ||
      (l.provider !== 'claude' && l.provider !== 'codex') ||
      !validKey(l.provider, l.account_key) ||
      !Number.isSafeInteger(l.expires_at_ms) ||
      !Number.isSafeInteger(l.created_at_ms) ||
      Number(l.created_at_ms) < 0 ||
      Number(l.expires_at_ms) < 0 ||
      typeof l.pinned !== 'boolean' ||
      !(l.model === null || nonempty(l.model))
    )
      throw new AccountError('invalid-state', 'Invalid session lease');
    seen.add(l.id);
  }
  return value as LeaseState;
}
export function readLeases(paths: StatePaths, now = Date.now()): LeaseState {
  checkPrivateDirectory(paths.stateRoot);
  const state = readPrivate(leaseFile(paths), validate, () => ({
    schema_version: 1 as const,
    leases: [],
    last_selected: {},
  }));
  state.leases = state.leases.filter((l) => l.expires_at_ms > now);
  return state;
}
export async function changeLeases<T>(
  paths: StatePaths,
  fn: (s: LeaseState) => T | Promise<T>,
): Promise<T> {
  privateDirectory(paths.stateRoot);
  return withLock(join(serviceDirectory(paths), 'leases.lock'), async () => {
    const s = readLeases(paths);
    const result = await fn(s);
    writePrivate(leaseFile(paths), s);
    return result;
  });
}
export function issueLease(
  state: LeaseState,
  provider: ManagedProvider,
  accountKey: string,
  now = Date.now(),
  options: { pinned?: boolean; model?: string } = {},
): IssuedLease {
  if (state.leases.length >= 1024)
    throw new AccountError(
      'session-limit',
      'Too many active session leases',
      503,
    );
  const id = randomUUID(),
    nonce = randomBytes(32).toString('base64url'),
    expires = now + LEASE_TTL_MS;
  state.leases.push({
    id,
    token_hash: digest(`${id}.${nonce}`),
    account_key: accountKey,
    provider,
    created_at_ms: now,
    expires_at_ms: expires,
    pinned: options.pinned ?? false,
    model: options.model ?? null,
  });
  state.last_selected[provider] = accountKey;
  return {
    leaseId: id,
    ownerNonce: nonce,
    accountKey,
    expiresAt: new Date(expires).toISOString(),
  };
}
export const leaseToken = (lease: IssuedLease) =>
  `${lease.leaseId}.${lease.ownerNonce}`;
export function authorizedLease(
  state: LeaseState,
  token: string,
  provider?: ManagedProvider,
): SessionLease {
  const id = token.split('.')[0];
  const l = state.leases.find((l) => l.id === id);
  if (
    !l ||
    l.expires_at_ms <= Date.now() ||
    (provider && l.provider !== provider) ||
    !timingSafeEqual(
      Buffer.from(l.token_hash, 'hex'),
      Buffer.from(digest(token), 'hex'),
    )
  )
    throw new AccountError(
      'invalid-lease',
      'Session lease is missing, expired, or belongs to another provider',
      401,
    );
  return l;
}
export async function renewLease(
  paths: StatePaths,
  token: string,
  release = false,
): Promise<{ account_key: string }> {
  return changeLeases(paths, (state) => {
    const l = authorizedLease(state, token);
    if (release) state.leases = state.leases.filter((x) => x !== l);
    else l.expires_at_ms = Date.now() + LEASE_TTL_MS;
    return { account_key: l.account_key };
  });
}
export function activeCounts(state: LeaseState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of state.leases)
    counts.set(l.account_key, (counts.get(l.account_key) ?? 0) + 1);
  return counts;
}
