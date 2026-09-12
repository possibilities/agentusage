import type { StatePaths } from '../paths.ts';
import { AccountError } from './storage.ts';
import {
  accessAccount,
  providerHeaders,
  rejectCredential,
} from './credentials.ts';
import {
  changePool,
  readPool,
  type ManagedAccount,
  type ManagedProvider,
} from './store.ts';
import { jsonBody, providerURL, retryDelay, type Env } from './http.ts';
import { parseClaudeUsage } from '../claude/observe.ts';
import { hasCodexBindingWindows, parseCodexUsage } from '../codex/observe.ts';
import {
  laneHeadroomPercent,
  MAIN_LANE_ID,
  SPARK_LANE_ID,
} from '../codex/types.ts';

export async function refreshUsage(
  paths: StatePaths,
  provider: ManagedProvider,
  env: Env = process.env,
  force = false,
): Promise<ManagedAccount[]> {
  const keys = readPool(paths)
    .accounts.filter(
      (a) => a.provider === provider && a.enabled && !a.auth_error,
    )
    .map((a) => a.key);
  // Small bounded pool: no per-account runtime or unbounded network fanout.
  for (const key of keys) {
    const before = readPool(paths).accounts.find((a) => a.key === key);
    if (
      !before ||
      (before.next_poll_at_ms > Date.now() &&
        (!force || before.usage_error !== null))
    )
      continue;
    try {
      let a = await accessAccount(paths, key, env);
      const endpoint =
        provider === 'claude' ? '/api/oauth/usage' : '/backend-api/wham/usage';
      const request = (path: string) =>
        fetch(providerURL(provider, path, env), {
          redirect: 'manual',
          signal: AbortSignal.timeout(12_000),
          headers: providerHeaders(a),
        });
      let refreshed = false;
      const authenticatedRequest = async (path: string) => {
        let response = await request(path);
        if (response.status === 401 && !refreshed) {
          await response.body?.cancel();
          a = await accessAccount(paths, key, env, a.credentials.generation);
          refreshed = true;
          response = await request(path);
        }
        if (response.status === 401)
          await rejectCredential(paths, key, a.credentials.generation);
        return response;
      };
      let response = await authenticatedRequest(endpoint);
      if (response.status === 404 && provider === 'codex') {
        await response.body?.cancel();
        response = await authenticatedRequest('/api/codex/usage');
      }
      if (response.status !== 200) {
        const status = response.status,
          delay = retryDelay(response);
        await response.body?.cancel();
        await changePool(paths, (pool) => {
          const current = pool.accounts.find((x) => x.key === key);
          if (current) {
            current.usage_error = { code: `http-${status}`, status };
            current.next_poll_at_ms = Date.now() + delay;
          }
        });
        continue;
      }
      const body = await jsonBody(response);
      if (provider === 'claude') {
        const parsed = parseClaudeUsage(body);
        if (
          parsed.malformedScoped ||
          !parsed.windows.some((w) => w.key === 'session') ||
          !parsed.windows.some((w) => w.key === 'week')
        )
          throw new AccountError(
            'invalid-response',
            'Claude usage omitted valid binding windows',
            502,
          );
      } else {
        const parsed = parseCodexUsage(body, Date.now());
        if (!hasCodexBindingWindows(body, parsed.lanes))
          throw new AccountError(
            'invalid-response',
            'Codex usage omitted valid binding windows',
            502,
          );
      }
      if (provider === 'codex') {
        const count = (
          body.rate_limit_reset_credits as
            | { available_count?: unknown }
            | undefined
        )?.available_count;
        if (typeof count === 'number' && count > 0) {
          try {
            const details = await request(
              '/api/codex/rate-limit-reset-credits',
            );
            if (details.ok)
              body.rate_limit_reset_credit_details = await jsonBody(details);
            else await details.body?.cancel();
          } catch {}
        }
      }
      // Parsers decide whether a successful payload contains decision-grade windows.
      const measuredAtMs = Date.now();
      const codexUsage =
        provider === 'codex' ? parseCodexUsage(body, measuredAtMs) : null;
      await changePool(paths, (pool) => {
        const current = pool.accounts.find((x) => x.key === key);
        if (current) {
          current.usage = { measured_at_ms: measuredAtMs, value: body };
          current.usage_error = null;
          current.next_poll_at_ms = Date.now() + 180_000;
          if (codexUsage !== null) {
            for (const laneId of [MAIN_LANE_ID, SPARK_LANE_ID]) {
              const lane = codexUsage.lanes.find(
                (candidate) => candidate.id === laneId,
              );
              const headroom =
                lane === undefined ? null : laneHeadroomPercent(lane);
              const confirmsCapacity =
                headroom !== null &&
                headroom > 0 &&
                (laneId !== MAIN_LANE_ID || codexUsage.limitReached !== true);
              const blockedAt = current.quota_blocked_at_ms?.[laneId];
              if (
                confirmsCapacity &&
                (blockedAt === undefined || measuredAtMs > blockedAt)
              ) {
                delete current.quota_blocks[laneId];
                if (current.quota_blocked_at_ms !== undefined) {
                  delete current.quota_blocked_at_ms[laneId];
                  if (Object.keys(current.quota_blocked_at_ms).length === 0)
                    delete current.quota_blocked_at_ms;
                }
              }
            }
          }
        }
      });
    } catch (e) {
      await changePool(paths, (pool) => {
        const a = pool.accounts.find((x) => x.key === key);
        if (a) {
          a.usage_error = {
            code: e instanceof AccountError ? e.code : 'usage-unavailable',
            status: null,
          };
          a.next_poll_at_ms = Date.now() + 60_000;
        }
      });
    }
  }
  return readPool(paths).accounts.filter((a) => a.provider === provider);
}
