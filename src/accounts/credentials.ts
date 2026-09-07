import type { StatePaths } from '../paths.ts';
import { AccountError, nonempty, record } from './storage.ts';
import { changePool, jwtClaims, type ManagedAccount } from './store.ts';
import { jsonBody, providerURL, retryDelay, type Env } from './http.ts';

const CLIENT_IDS = {
  codex: 'app_EMoamEEZ73f0CkXaXp7hrann',
  claude: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
};
export async function accessAccount(
  paths: StatePaths,
  key: string,
  env: Env = process.env,
  rejectedGeneration?: number,
): Promise<ManagedAccount> {
  const outcome = await changePool(paths, async (pool) => {
    const a = pool.accounts.find((a) => a.key === key);
    if (!a || !a.enabled)
      return {
        error: new AccountError(
          'account-unavailable',
          'Pinned account is missing or disabled',
          403,
        ),
      };
    if (a.auth_error)
      return {
        error: new AccountError(
          'relogin-required',
          'Pinned account requires login',
          401,
        ),
      };
    const now = Date.now(),
      c = a.credentials;
    const mustRefresh =
      c.expires_at_ms <= now + 60_000 || rejectedGeneration === c.generation;
    if (!mustRefresh) return { account: structuredClone(a) };
    if (a.refresh_after_ms > now)
      return {
        error: new AccountError(
          'refresh-backoff',
          'Credential refresh is cooling down',
          503,
        ),
      };
    if (!c.refresh_token) {
      a.auth_error = 'relogin-required';
      return {
        error: new AccountError(
          'relogin-required',
          'Credential expired or was rejected; sign in again',
          401,
        ),
      };
    }
    let response: Response;
    try {
      response = await fetch(
        providerURL(
          a.provider,
          a.provider === 'codex' ? '/oauth/token' : '/v1/oauth/token',
          env,
          true,
        ),
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: c.refresh_token,
            client_id: CLIENT_IDS[a.provider],
          }),
        },
      );
    } catch {
      a.refresh_after_ms = now + 30_000;
      return {
        error: new AccountError(
          'refresh-network',
          'Credential refresh could not reach the provider',
          503,
        ),
      };
    }
    if (response.status !== 200) {
      if (response.status === 400 || response.status === 401)
        a.auth_error = 'relogin-required';
      else a.refresh_after_ms = now + retryDelay(response, now);
      await response.body?.cancel().catch(() => {});
      return {
        error: new AccountError(
          a.auth_error ?? 'refresh-unavailable',
          `Credential refresh returned HTTP ${response.status}`,
          a.auth_error ? 401 : 503,
        ),
      };
    }
    let body: Record<string, unknown>;
    try {
      body = await jsonBody(response);
    } catch {
      a.refresh_after_ms = now + 60_000;
      return {
        error: new AccountError(
          'refresh-invalid',
          'Invalid credential refresh response',
          502,
        ),
      };
    }
    const access = body.access_token,
      refresh = body.refresh_token ?? c.refresh_token;
    const claims = typeof access === 'string' ? jwtClaims(access) : {};
    const auth = record(claims['https://api.openai.com/auth']);
    if (
      a.provider === 'codex' &&
      nonempty(auth?.chatgpt_account_id) &&
      auth.chatgpt_account_id !== a.account_id
    ) {
      a.auth_error = 'identity-mismatch';
      return {
        error: new AccountError(
          'identity-mismatch',
          'Refreshed credential changed account identity',
          401,
        ),
      };
    }
    const expires =
      typeof body.expires_in === 'number'
        ? Date.now() + body.expires_in * 1000
        : typeof claims.exp === 'number'
          ? claims.exp * 1000
          : NaN;
    if (
      !nonempty(access) ||
      !nonempty(refresh) ||
      !Number.isFinite(expires) ||
      expires <= Date.now()
    ) {
      a.auth_error = 'relogin-required';
      return {
        error: new AccountError(
          'refresh-invalid',
          'Refresh response did not contain usable credentials',
          502,
        ),
      };
    }
    a.credentials = {
      access_token: access,
      refresh_token: refresh,
      expires_at_ms: expires,
      generation: c.generation + 1,
    };
    a.refresh_after_ms = 0;
    return { account: structuredClone(a) };
  });
  if (outcome.error) throw outcome.error;
  return outcome.account!;
}
/** A stale request must not quarantine a newer credential installed concurrently. */
export async function rejectCredential(
  paths: StatePaths,
  key: string,
  generation: number,
): Promise<void> {
  await changePool(paths, (pool) => {
    const account = pool.accounts.find((a) => a.key === key);
    if (account?.credentials.generation === generation)
      account.auth_error = 'relogin-required';
  });
}

export function providerHeaders(
  a: ManagedAccount,
  incoming?: Headers,
): Headers {
  const h = new Headers(incoming);
  const connection = (h.get('connection') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const key of [
    ...connection,
    'host',
    'connection',
    'keep-alive',
    'proxy-connection',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'cookie',
    'x-api-key',
    'authorization',
    'content-length',
    'chatgpt-account-id',
  ])
    h.delete(key);
  h.set('authorization', `Bearer ${a.credentials.access_token}`);
  if (a.provider === 'codex') {
    h.set('chatgpt-account-id', a.account_id);
    h.set('openai-beta', 'responses=experimental');
    h.set('originator', 'codex_cli_rs');
  } else {
    const beta = new Set(
      (h.get('anthropic-beta') ?? '').split(',').filter(Boolean),
    );
    beta.add('oauth-2025-04-20');
    h.set('anthropic-beta', [...beta].join(','));
    if (!h.has('anthropic-version')) h.set('anthropic-version', '2023-06-01');
  }
  return h;
}
