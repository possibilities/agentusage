import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { changeGrokAccount, loginGrokAccount, recoverGrokAccount } from '../src/grok/accounts.ts';
import { observeAccount, publicObservation } from '../src/grok/billing.ts';
import { observeGrok } from '../src/grok/observe.ts';
import { refreshCredentials } from '../src/grok/oauth.ts';
import { readState, statePath } from '../src/grok/store.ts';
import { providerURL } from '../src/accounts/http.ts';
import { refreshGrokObservation } from '../src/observe.ts';
import { selectGrokAccount } from '../src/balance/grok.ts';
import { fixtureState } from './managed-fixtures.ts';
import { account, grokCli, seedGrok } from './grok-fixtures.ts';

const billingReply = { config: { creditUsagePercent: 10, prepaidBalance: {}, onDemandCap: {}, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-01T00:00:00Z' } } };
function endpoint(fixture: ReturnType<typeof fixtureState>, fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  return { server, env: { ...fixture.env, AGENTUSAGE_TEST_GROK_ORIGIN: `http://127.0.0.1:${server.port}` } };
}

describe('owned Grok OAuth and billing', () => {
  test('uses fixed production origins and refuses unsafe fixture overrides', () => {
    expect(providerURL('grok', '/oauth2/token', {}, true)).toBe('https://auth.x.ai/oauth2/token');
    expect(providerURL('grok', '/v1/billing?format=credits', {})).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    for (const origin of ['https://evil.example', 'http://localhost:1234', 'http://127.0.0.1:1234/extra', 'http://user@127.0.0.1:1234'])
      expect(() => providerURL('grok', '/', { AGENTUSAGE_STATE_ROOT: '/tmp/fixture', AGENTUSAGE_TEST_GROK_ORIGIN: origin })).toThrow();
    expect(() => providerURL('grok', '/', { AGENTUSAGE_TEST_GROK_ORIGIN: 'http://127.0.0.1:1234' })).toThrow();
  });

  test('preserves an omitted rotated refresh token after verifying the same identity', async () => {
    const fixture = fixtureState();
    const { server, env } = endpoint(fixture, (request) => new URL(request.url).pathname.endsWith('userinfo')
      ? Response.json({ sub: 'acct_1', email: 'new@example.test' }) : Response.json({ access_token: 'new-access', expires_in: 3600 }));
    try {
      const result = await refreshCredentials(account(1).credentials, 'acct_1', env);
      expect(result.credentials.accessToken).toBe('new-access');
      expect(result.credentials.refreshToken).toBe('refresh-1');
      expect(result.email).toBe('new@example.test');
    } finally { server.stop(true); }
  });

  test('refuses changed identities and never replaces the old credential with that rotation', async () => {
    const fixture = fixtureState();
    const row = account(1); row.credentials.expiresAtMs = 0;
    await seedGrok(fixture.paths, [row]);
    const { server, env } = endpoint(fixture, (request) => new URL(request.url).pathname.endsWith('userinfo')
      ? Response.json({ sub: 'other-account' }) : Response.json({ access_token: 'untrusted-access', refresh_token: 'untrusted-rotation', expires_in: 3600 }));
    try {
      const observation = await observeGrok({ env, refresh: true });
      expect(observation.accounts[0]?.authStatus).toBe('error');
      expect((await readState(fixture.paths)).accounts[0]!.credentials).toEqual(row.credentials);
      expect(JSON.stringify(observation)).not.toContain('untrusted-');
    } finally { server.stop(true); }
  });

  test('durably saves verified rotated credentials before a later billing failure', async () => {
    const fixture = fixtureState();
    const row = account(1); row.credentials.expiresAtMs = 0;
    await seedGrok(fixture.paths, [row]);
    let billingSawSavedRotation = false;
    const { server, env } = endpoint(fixture, (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/oauth2/token') return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      if (path === '/oauth2/userinfo') return Response.json({ sub: 'acct_1' });
      billingSawSavedRotation = JSON.parse(readFileSync(statePath(fixture.paths), 'utf8')).accounts[0].credentials.refreshToken === 'new-refresh';
      return new Response('upstream body must stay private', { status: 503 });
    });
    try {
      const observed = await observeGrok({ env, refresh: true });
      expect(billingSawSavedRotation).toBe(true);
      const stored = (await readState(fixture.paths)).accounts[0]!;
      expect(stored.credentials.refreshToken).toBe('new-refresh');
      expect(stored.observation.lastGood).toEqual(row.observation.lastGood);
      expect(stored.observation.error?.code).toBe('billing_http_error');
      expect(JSON.stringify(observed)).not.toContain('new-refresh');
      expect(JSON.stringify(observed)).not.toContain('upstream body');
    } finally { server.stop(true); }
  });

  test('a targeted refresh keeps every account in the sidecar and leaves the other account untouched', async () => {
    const fixture = fixtureState();
    const rows = [account(1), account(2)];
    await seedGrok(fixture.paths, rows);
    const requests: string[] = [];
    const { server, env } = endpoint(fixture, (request) => {
      requests.push(request.headers.get('x-userid') ?? 'missing');
      return Response.json(billingReply);
    });
    try {
      const result = await refreshGrokObservation(fixture.paths, { env, providerRefresh: true, account: 'grok-2', freshWithinMs: 0 });
      expect(result.value?.accounts).toHaveLength(2);
      expect(requests).toEqual(['acct_2']);
      const stored = (await readState(fixture.paths)).accounts;
      expect(stored[0]).toEqual(rows[0]);
      expect(stored[1]!.observation.lastGood?.included.usedPercent).toBe(10);
    } finally { server.stop(true); }
  });

  test('billing backoff retains last-good data and a forced refresh bypasses it without refreshing a valid token', async () => {
    const fixture = fixtureState(); await seedGrok(fixture.paths, [account(1)]);
    const requests: string[] = [];
    const { server, env } = endpoint(fixture, (request) => {
      requests.push(new URL(request.url).pathname); return new Response('private error', { status: 503 });
    });
    try {
      await observeGrok({ env }); await observeGrok({ env });
      expect(requests).toEqual(['/v1/billing']);
      await observeGrok({ env, refresh: true });
      expect(requests).toEqual(['/v1/billing', '/v1/billing']);
      const stored = (await readState(fixture.paths)).accounts[0]!;
      expect(stored.observation.lastGood).not.toBeNull();
      expect(stored.observation.failureCount).toBe(2);
      expect(stored.observation.nextAttemptAtMs).toBeGreaterThan(Date.now());
    } finally { server.stop(true); }
  });

  test('billing rejection quarantines selection until explicit recovery succeeds', async () => {
    const fixture = fixtureState(); await seedGrok(fixture.paths, [account(1)]);
    let denied = true;
    const { server, env } = endpoint(fixture, (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/oauth2/token') return Response.json({ access_token: 'recovered-access', refresh_token: 'recovered-refresh', expires_in: 3600 });
      if (path === '/oauth2/userinfo') return Response.json({ sub: 'acct_1' });
      return denied ? new Response('denied', { status: 401 }) : Response.json(billingReply);
    });
    try {
      await observeGrok({ env, refresh: true });
      expect(await selectGrokAccount({ env, account: 'grok-1', allowUnknown: true })).toMatchObject({ ok: false, refusal: 'auth-unavailable' });
      denied = false;
      expect(await recoverGrokAccount(fixture.paths, 'grok-1', env)).toMatchObject({ key: 'grok-1', auth_status: 'valid' });
      expect(await selectGrokAccount({ env, account: 'grok-1' })).toMatchObject({ ok: true, accountKey: 'grok-1' });
    } finally { server.stop(true); }
  });

  test('parallel refresh callers share one publication and one rotation', async () => {
    const fixture = fixtureState(); const row = account(1); row.credentials.expiresAtMs = 0;
    await seedGrok(fixture.paths, [row]);
    let tokenCalls = 0; let billingCalls = 0;
    const { server, env } = endpoint(fixture, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/oauth2/token') { tokenCalls++; await Bun.sleep(100); return Response.json({ access_token: 'parallel-access', refresh_token: 'parallel-refresh', expires_in: 3600 }); }
      if (path === '/oauth2/userinfo') return Response.json({ sub: 'acct_1' });
      billingCalls++; return Response.json(billingReply);
    });
    try {
      const results = await Promise.all([1, 2].map(() => refreshGrokObservation(fixture.paths, { env, providerRefresh: true, freshWithinMs: 0 })));
      expect(results.map((r) => r.outcome).sort()).toEqual(['peer-published', 'refreshed']);
      expect(tokenCalls).toBe(1); expect(billingCalls).toBe(1);
    } finally { server.stop(true); }
  });

  test('rejects redirects, reflected OAuth secrets, oversized bodies, and an expired request budget', async () => {
    const fixture = fixtureState(); let mode = 'redirect'; let unwanted = 0;
    const { server, env } = endpoint(fixture, (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/unwanted') { unwanted++; return Response.json(billingReply); }
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: '/unwanted' } });
      if (mode === 'reflect') return Response.json({ error: 'REFLECTED_REFRESH_SECRET', error_description: 'REFLECTED_ACCESS_SECRET' }, { status: 400 });
      return new Response('x'.repeat(300_000), { headers: { 'content-type': 'application/json' } });
    });
    try {
      const row = account(1);
      await observeAccount(row, { force: true, env });
      expect(row.observation.error?.code).toBe('billing_http_error'); expect(unwanted).toBe(0);
      mode = 'reflect'; row.credentials.expiresAtMs = 0;
      await observeAccount(row, { force: true, env });
      expect(JSON.stringify(publicObservation(row))).not.toContain('REFLECTED_');
      mode = 'oversized'; row.credentials.expiresAtMs = Date.now() + 3600_000;
      await observeAccount(row, { force: true, env });
      expect(row.observation.error?.code).toBe('billing_response_invalid');
      await observeAccount(row, { force: true, env, deadlineMs: Date.now() - 1 });
      expect(row.observation.error?.code).toBe('observation_timeout');
    } finally { server.stop(true); }
  });

  test('device login reauthenticates a stable identity, rejects a changed target, and never recycles ordinals', async () => {
    const fixture = fixtureState(); let identity = 1; let origin = '';
    const { server, env } = endpoint(fixture, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/oauth2/device/code') {
        const form = await request.formData();
        expect(form.get('scope')).toBe('openid profile email offline_access grok-cli:access api:access');
        return Response.json({ device_code: 'private-device-code', user_code: 'TEST-1234', verification_uri: `${origin}/verify`, expires_in: 30, interval: 1 });
      }
      if (path === '/oauth2/token') return Response.json({ access_token: `device-access-${identity}`, refresh_token: `device-refresh-${identity}`, expires_in: 3600 });
      return Response.json({ sub: `acct_${identity}`, email: `user${identity}@example.test` });
    });
    origin = env.AGENTUSAGE_TEST_GROK_ORIGIN;
    try {
      const first = await grokCli(['accounts', 'login', 'grok', '--no-open', '--label', 'work', '--json'], env);
      expect(first.code).toBe(0); expect(first.data.account.key).toBe('grok-1');
      expect(first.stdout + first.stderr).not.toContain('device-access-');
      expect(first.stdout + first.stderr).not.toContain('device-refresh-');
      const login = (key?: string) => loginGrokAccount(fixture.paths, { env, account: key, openBrowser: false, onPrompt: () => {} });
      expect(await login('work')).toMatchObject({ key: 'grok-1', label: 'work' });
      identity = 2;
      await expect(login('grok-1')).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect((await readState(fixture.paths)).accounts).toHaveLength(1);
      await changeGrokAccount(fixture.paths, 'remove', 'grok-1');
      expect(await login()).toMatchObject({ key: 'grok-2' });
    } finally { server.stop(true); }
  }, 10_000);
});
