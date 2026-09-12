import type { StatePaths } from '../paths.ts';
import { changePool, readPool } from '../accounts/store.ts';
import { record } from '../accounts/storage.ts';
import { retryDelay } from '../accounts/http.ts';
import { buildCodexObservation } from '../codex/observe.ts';
import { chooseCodexWithLeases } from '../balance/codex.ts';
import { effectiveCodexFullFocus, readFullFocusLeaf } from '../focus.ts';
import { authorizedLease, changeLeases } from './leases.ts';

/** References to stored provider objects are account-bound even without a response id.
 * Walk iteratively so deeply nested, bounded JSON cannot overflow the call stack. */
export function replayableRequest(
  payload: Record<string, unknown> | null,
): boolean {
  if (!payload || payload.input == null) return false;
  const pending: unknown[] = [payload];
  const boundKeys = new Set([
    'previous_response_id',
    'conversation',
    'file_id',
    'file_ids',
    'container',
    'container_id',
    'vector_store_ids',
    'encrypted_content',
  ]);
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
      continue;
    }
    const item = record(value);
    if (!item) continue;
    if (item.type === 'item_reference' || record(item.prompt)?.id != null)
      return false;
    for (const [key, child] of Object.entries(item)) {
      if (boundKeys.has(key) && child != null) return false;
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
  return true;
}

export function quotaResetAt(
  body: string,
  response: Response,
  now = Date.now(),
): number | null {
  if (response.status !== 429) return null;
  let error: Record<string, unknown> | null;
  try {
    error = record(record(JSON.parse(body))?.error);
  } catch {
    return null;
  }
  // A short request-rate throttle is not evidence that the subscription is exhausted.
  if (
    error?.type !== 'usage_limit_reached' &&
    error?.code !== 'usage_limit_reached'
  )
    return null;
  const epoch =
    typeof error.resets_at === 'number' ? error.resets_at * 1000 : NaN;
  const duration =
    typeof error.resets_in_seconds === 'number'
      ? now + error.resets_in_seconds * 1000
      : NaN;
  const candidate = Number.isFinite(epoch)
    ? epoch
    : Number.isFinite(duration)
      ? duration
      : now + retryDelay(response, now);
  return Math.round(
    Math.max(now + 1_000, Math.min(now + 7 * 86400_000, candidate)),
  );
}

export async function recordQuotaExhaustion(
  paths: StatePaths,
  key: string,
  model: string | null,
  until: number,
): Promise<void> {
  const lane = model && /spark/iu.test(model) ? 'codex-spark' : 'main';
  await changePool(paths, (pool) => {
    const account = pool.accounts.find((a) => a.key === key);
    if (account) {
      account.quota_blocks[lane] = Math.max(
        account.quota_blocks[lane] ?? 0,
        until,
      );
      account.quota_blocked_at_ms ??= {};
      account.quota_blocked_at_ms[lane] = Date.now();
      account.next_poll_at_ms = Math.min(account.next_poll_at_ms, until);
    }
  });
}

/** Serialized lease reassignment; explicit account pins cannot cross this boundary. */
export async function rebalanceLease(
  paths: StatePaths,
  token: string,
  rejectedKey: string,
  model: string | null,
  attempted: ReadonlySet<string>,
): Promise<string | null> {
  return changeLeases(paths, (state) => {
    const lease = authorizedLease(state, token, 'codex');
    if (lease.pinned) return null;
    if (lease.account_key !== rejectedKey && !attempted.has(lease.account_key))
      return lease.account_key;
    const accounts = readPool(paths).accounts.filter(
      (a) => !attempted.has(a.key),
    );
    const observation = buildCodexObservation(accounts, Date.now());
    const focus = effectiveCodexFullFocus(
      readFullFocusLeaf(paths.codexFullFocusLeaf, 'codex'),
      observation,
      Date.now(),
    );
    const selection = chooseCodexWithLeases(
      observation,
      model && /spark/iu.test(model) ? 'codex-spark' : 'main',
      {},
      state,
      focus.state === 'active' ? (focus.policy?.target ?? null) : null,
    );
    if (!selection.ok) return null;
    lease.account_key = selection.accountKey;
    state.last_selected.codex = selection.accountKey;
    return lease.account_key;
  });
}
