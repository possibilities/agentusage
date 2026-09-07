import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountFile,
  changePool,
  importAccount,
  publicAccount,
  readPool,
} from '../src/accounts/store.ts';
import {
  accessAccount,
  rejectCredential,
} from '../src/accounts/credentials.ts';
import { refreshUsage } from '../src/accounts/usage.ts';
import { identifyImport } from '../src/accounts/login.ts';
import {
  lockFile,
  tryLockFile,
  writePrivate,
} from '../src/accounts/storage.ts';
import { buildObservation } from '../src/claude/observe.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import {
  startProxy,
  endpointURL,
  readyEndpoint,
} from '../src/service/proxy.ts';
import {
  authorizedLease,
  changeLeases,
  issueLease,
  leaseToken,
  readLeases,
  renewLease,
} from '../src/service/leases.ts';
import { prepareLaunch } from '../src/service/prepare.ts';
import { fixtureState, managed, seed, codexUsage } from './managed-fixtures.ts';

const servers: Array<{ stop(close?: boolean): unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});
function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(server);
  return server;
}
async function proxyFixture(
  handler: (request: Request) => Response | Promise<Response>,
  options: Parameters<typeof startProxy>[1] = {},
) {
  const state = fixtureState();
  await seed(state, [managed(), managed('codex', 2), managed('claude')]);
  const source = upstream(handler);
  const env = {
    ...state.env,
    AGENTUSAGE_TEST_CODEX_ORIGIN: source.url.origin,
    AGENTUSAGE_TEST_CLAUDE_ORIGIN: source.url.origin,
  };
  const proxy = await startProxy(state.paths, { ...options, env, port: 0 });
  servers.push({ stop: () => proxy.stop(0) });
  const issue = async (
    provider: 'claude' | 'codex' = 'codex',
    pinned = false,
  ) => {
    const issued = await changeLeases(state.paths, (s) =>
      issueLease(s, provider, `${provider}-1`, Date.now(), { pinned }),
    );
    return leaseToken(issued);
  };
  const request = (
    token: string,
    body: object = { model: 'gpt-test', input: 'hello' },
    path = '/codex/responses',
    signal?: AbortSignal,
  ) =>
    fetch(endpointURL(proxy.endpoint) + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  return { ...state, env, source, proxy, issue, request };
}

describe('owned credential lifecycle', () => {
  test('stable account ids never reuse ordinals; reauth cannot change identity; public output has no secrets', async () => {
    const state = fixtureState();
    const a = managed();
    const native = { account_id: a.account_id, ...a.credentials };
    expect(await importAccount(state.paths, 'codex', native)).toMatchObject({
      key: 'codex-1',
      account_id: a.account_id,
    });
    expect(await importAccount(state.paths, 'codex', native)).toMatchObject({
      key: 'codex-1',
    });
    expect(
      JSON.stringify(publicAccount(readPool(state.paths).accounts[0]!)),
    ).not.toContain('access-');
    expect(
      JSON.stringify(publicAccount(readPool(state.paths).accounts[0]!)),
    ).not.toContain('refresh-');
    await expect(
      importAccount(
        state.paths,
        'codex',
        { ...native, account_id: 'other' },
        { account: 'codex-1' },
      ),
    ).rejects.toThrow('same account identity');
    await changePool(state.paths, (p) => {
      p.accounts = [];
    });
    expect(await importAccount(state.paths, 'codex', native)).toMatchObject({
      key: 'codex-2',
    });
  });
  test('import refuses an account id conflicting with native token claims', async () => {
    const state = fixtureState();
    const claims = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'actual' },
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    await expect(
      importAccount(state.paths, 'codex', {
        account_id: 'other',
        access_token: `header.${claims}.signature`,
      }),
    ).rejects.toThrow('conflicts with its account identity');
    expect(readPool(state.paths).accounts).toHaveLength(0);
  });
  test('private files and symlinked state are refused; kernel locks do not steal live ownership', async () => {
    const state = fixtureState();
    await seed(state, [managed()]);
    chmodSync(accountFile(state.paths), 0o644);
    expect(() => readPool(state.paths)).toThrow('private');
    chmodSync(accountFile(state.paths), 0o600);
    const link = join(state.root, 'alias');
    symlinkSync(join(state.root, 'accounts'), link);
    expect(() => writePrivate(join(link, 'new.json'), {})).toThrow(
      'not a symlink',
    );
    const lock = join(state.root, 'test.lock');
    const release = await lockFile(lock, 0);
    expect(() => tryLockFile(lock)).toThrow('busy');
    release();
    tryLockFile(lock)();
  });
  test('parallel expired-token and rejected-generation refreshes rotate exactly once', async () => {
    let refreshes = 0;
    const server = upstream(async (req) => {
      expect(new URL(req.url).pathname).toBe('/oauth/token');
      expect(await req.json()).toMatchObject({
        refresh_token: 'refresh-codex-1',
      });
      refreshes++;
      await Bun.sleep(20);
      return Response.json({
        access_token: 'rotated',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });
    });
    const state = fixtureState();
    const a = managed();
    a.credentials.expires_at_ms = Date.now() - 1;
    await seed(state, [a]);
    const env = {
      ...state.env,
      AGENTUSAGE_TEST_CODEX_ORIGIN: server.url.origin,
    };
    const result = await Promise.all(
      Array.from({ length: 8 }, () =>
        accessAccount(state.paths, a.key, env, 1),
      ),
    );
    expect(refreshes).toBe(1);
    expect(result.every((a) => a.credentials.generation === 2)).toBe(true);
    expect(readPool(state.paths).accounts[0]!.credentials.refresh_token).toBe(
      'rotated-refresh',
    );
  });
  test('refresh rejection persists quarantine, and usage failures preserve last-good data and backoff', async () => {
    let calls = 0;
    const server = upstream(() => {
      calls++;
      return Response.json({ incomplete: true });
    });
    const state = fixtureState();
    const a = managed('codex', 1, { next_poll_at_ms: 0 });
    await seed(state, [a]);
    const env = {
      ...state.env,
      AGENTUSAGE_TEST_CODEX_ORIGIN: server.url.origin,
    };
    await refreshUsage(state.paths, 'codex', env);
    expect(readPool(state.paths).accounts[0]!.usage).toEqual(a.usage);
    expect(readPool(state.paths).accounts[0]!.usage_error?.code).toBe(
      'invalid-response',
    );
    await refreshUsage(state.paths, 'codex', env);
    expect(calls).toBe(1);
    const reject = upstream(() => new Response('', { status: 400 }));
    await changePool(state.paths, (p) => {
      p.accounts[0]!.credentials.expires_at_ms = 1;
    });
    await expect(
      accessAccount(state.paths, a.key, {
        ...state.env,
        AGENTUSAGE_TEST_CODEX_ORIGIN: reject.url.origin,
      }),
    ).rejects.toThrow('HTTP 400');
    expect(readPool(state.paths).accounts[0]!.auth_error).toBe(
      'relogin-required',
    );
  });
  test('weekly-only usage refreshes both native variants and permits pinned dry runs without leases', async () => {
    const state = fixtureState();
    const accounts = [1, 2].map((ordinal) => managed('codex', ordinal, {
      usage: null, next_poll_at_ms: 0,
    }));
    await seed(state, accounts);
    const source = upstream((request) => {
      expect(new URL(request.url).pathname).toBe('/backend-api/wham/usage');
      const second = request.headers.get('chatgpt-account-id') === accounts[1]!.account_id;
      return Response.json({
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 14, limit_window_seconds: 604800,
            reset_at: Math.floor(Date.now() / 1000) + 604800,
          },
          ...(second ? {} : { secondary_window: null }),
        },
      });
    });
    const env = { ...state.env, AGENTUSAGE_TEST_CODEX_ORIGIN: source.url.origin };
    const refreshed = await refreshUsage(state.paths, 'codex', env);
    expect(refreshed.map((account) => account.usage_error)).toEqual([null, null]);
    const observation = buildCodexObservation(refreshed, Date.now());
    expect(observation.accounts.map((account) => account.headroomPercent)).toEqual([86, 86]);
    writePrivate(state.paths.codexObservation, observation);
    for (const account of accounts) {
      expect(await prepareLaunch(state.paths, 'codex', {
        account: account.account_id, dryRun: true,
      }, env)).toMatchObject({ account_key: account.key, lease: null });
    }
    expect(readLeases(state.paths).leases).toHaveLength(0);
  });
  test('Claude imports establish profile identity directly', async () => {
    const server = upstream((req) => {
      expect(req.headers.get('authorization')).toBe('Bearer fake-claude');
      return Response.json({
        account: { uuid: 'account-uuid', email: 'claude@example.test' },
      });
    });
    const state = fixtureState();
    const value = await identifyImport(
      'claude',
      {
        claudeAiOauth: {
          accessToken: 'fake-claude',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3600_000,
        },
      },
      { ...state.env, AGENTUSAGE_TEST_CLAUDE_ORIGIN: server.url.origin },
    );
    expect(await importAccount(state.paths, 'claude', value)).toMatchObject({
      key: 'claude-1',
      email: 'claude@example.test',
    });
  });
});

describe('prepare and lease contract', () => {
  test('native identity pins distinguish shared emails before eligibility and remain pinned', async () => {
    const f = await proxyFixture(() => Response.json(codexUsage()));
    await changePool(f.paths, (pool) => {
      pool.accounts[0]!.email = pool.accounts[1]!.email = 'shared@example.test';
      pool.accounts[0]!.enabled = false;
    });
    const preview = await prepareLaunch(
      f.paths, 'codex', { account: 'identity-codex-2', dryRun: true }, f.env,
    );
    expect(preview).toMatchObject({ account_key: 'codex-2', lease: null });
    for (const provider of ['codex', 'claude'] as const) {
      const key = provider === 'codex' ? 'codex-2' : 'claude-1';
      const prepared = await prepareLaunch(
        f.paths, provider, { account: `identity-${key}` }, f.env,
      );
      expect(prepared.account_key).toBe(key);
      expect(authorizedLease(readLeases(f.paths), prepared.lease!.token).pinned).toBe(true);
      await renewLease(f.paths, prepared.lease!.token, true);
    }
    await expect(prepareLaunch(
      f.paths, 'codex', { account: 'shared@example.test' }, f.env,
    )).rejects.toThrow('exactly one');
    await expect(prepareLaunch(
      f.paths, 'codex', { account: 'identity-codex-1' }, f.env,
    )).rejects.toThrow('Requested account');
    // Even an identity-shaped label cannot silently override another account.
    await changePool(f.paths, (pool) => { pool.accounts[0]!.label = 'identity-codex-2'; });
    await expect(prepareLaunch(
      f.paths, 'codex', { account: 'identity-codex-2' }, f.env,
    )).rejects.toThrow('exactly one');
    expect(readLeases(f.paths).leases).toHaveLength(0);
  });
  test('dry runs never create reservations, secrets or state; real preparation requires a daemon', async () => {
    const state = fixtureState();
    const accounts = [managed(), managed('claude')];
    await seed(state, accounts);
    writePrivate(
      state.paths.codexObservation,
      buildCodexObservation(accounts, Date.now()),
    );
    writePrivate(
      state.paths.claudeObservation,
      buildObservation(accounts, Date.now()),
    );
    const before = readdirSync(state.root, { recursive: true });
    for (const provider of ['codex', 'claude'] as const) {
      const prepared = await prepareLaunch(
        state.paths,
        provider,
        { dryRun: true },
        state.env,
      );
      expect(prepared.lease).toBeNull();
      expect(prepared.env).toEqual({ AGENTUSAGE_ACCOUNT: `${provider}-1` });
      expect(JSON.stringify(prepared)).not.toContain('access-');
    }
    expect(readdirSync(state.root, { recursive: true })).toEqual(before);
    await expect(
      prepareLaunch(state.paths, 'codex', {}, state.env),
    ).rejects.toThrow('Start agentusage daemon');
    expect(readLeases(state.paths).leases).toHaveLength(0);
  });
  test('empty explicit pins and model values refuse before creating any lease or state', async () => {
    const state = fixtureState();
    const before = readdirSync(state.root, { recursive: true });
    for (const provider of ['claude', 'codex'] as const) {
      await expect(
        prepareLaunch(
          state.paths,
          provider,
          { account: '', dryRun: true },
          state.env,
        ),
      ).rejects.toThrow('explicit account pin');
      await expect(
        prepareLaunch(state.paths, provider, { model: '' }, state.env),
      ).rejects.toThrow('requested model');
    }
    expect(readLeases(state.paths).leases).toHaveLength(0);
    expect(readdirSync(state.root, { recursive: true })).toEqual(before);
  });
  test('prepare preserves native homes, pins aliases and refuses disabled pins', async () => {
    const f = await proxyFixture(() => Response.json(codexUsage()));
    const prepared = await prepareLaunch(
      f.paths,
      'codex',
      { account: 'codex1@example.test' },
      { ...f.env, CODEX_HOME: '/native/history' },
    );
    expect(prepared.account_key).toBe('codex-1');
    expect(prepared.env['CODEX_HOME']).toBeUndefined();
    expect(
      authorizedLease(readLeases(f.paths), prepared.lease!.token).pinned,
    ).toBe(true);
    await renewLease(f.paths, prepared.lease!.token, true);
    expect(readLeases(f.paths).leases).toHaveLength(0);
    await changePool(f.paths, (p) => {
      p.accounts[0]!.enabled = false;
    });
    await expect(
      prepareLaunch(f.paths, 'codex', { account: 'codex-1' }, f.env),
    ).rejects.toThrow('Requested account');
  });
  test('daemon singleton and stable endpoint survive restart; leases retain identity and expire', async () => {
    const f = await proxyFixture(() => new Response('ok'));
    const token = await f.issue();
    await expect(startProxy(f.paths, { port: 0, env: f.env })).rejects.toThrow(
      'busy',
    );
    await f.proxy.stop(0);
    const replacement = await startProxy(f.paths, { env: f.env });
    servers.push({ stop: () => replacement.stop(0) });
    expect(replacement.endpoint).toEqual(f.proxy.endpoint);
    expect(await readyEndpoint(f.paths)).toEqual(replacement.endpoint);
    expect((await f.request(token)).status).toBe(200);
    await changeLeases(f.paths, (s) => {
      s.leases[0]!.expires_at_ms = Date.now() - 1;
    });
    await expect(renewLease(f.paths, token)).rejects.toThrow('expired');
    expect((await f.request(token)).status).toBe(401);
  });
});

describe('shared native proxy', () => {
  test('both providers use only their selected credential; tokens never escape errors; local authentication gates', async () => {
    const f = await proxyFixture((req) => {
      const auth = req.headers.get('authorization')!;
      if (new URL(req.url).pathname.startsWith('/v1/'))
        expect(auth).toBe('Bearer access-claude-1');
      else {
        expect(auth).toBe('Bearer access-codex-1');
        expect(req.headers.get('chatgpt-account-id')).toBe('identity-codex-1');
      }
      return new Response(auth + ' refresh-codex-1', { status: 400 });
    });
    const token = await f.issue();
    const response = await f.request(token);
    expect(await response.text()).not.toContain('access-codex-1');
    const claude = await f.issue('claude');
    expect((await f.request(claude, {}, '/claude/v1/messages')).status).toBe(
      400,
    );
    expect((await f.request(token, {}, '/claude/v1/messages')).status).toBe(
      401,
    );
    expect(
      (await fetch(endpointURL(f.proxy.endpoint) + '/health')).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpointURL(f.proxy.endpoint) + '/health', {
          headers: { origin: 'http://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect((await f.request(token, {}, '/codex/unrecognized')).status).toBe(
      404,
    );
  });
  test('confirmed quota rejection rebalances unpinned requests and all future requests; renewal reports it', async () => {
    const seen: string[] = [];
    const f = await proxyFixture((req) => {
      const account = req.headers.get('chatgpt-account-id')!;
      seen.push(account);
      return account.endsWith('-1')
        ? Response.json(
            { error: { type: 'usage_limit_reached', resets_in_seconds: 3600 } },
            { status: 429 },
          )
        : new Response('data: success\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
    });
    const token = await f.issue();
    expect(await (await f.request(token)).text()).toContain('success');
    expect(seen).toEqual(['identity-codex-1', 'identity-codex-2']);
    expect(await renewLease(f.paths, token)).toEqual({
      account_key: 'codex-2',
    });
    expect(await (await f.request(token)).text()).toContain('success');
    expect(seen.at(-1)).toBe('identity-codex-2');
    expect(readPool(f.paths).accounts[0]!.quota_blocks['main']).toBeGreaterThan(
      Date.now(),
    );
    const resumed = await prepareLaunch(f.paths, 'codex', {}, f.env);
    expect(resumed.account_key).toBe('codex-2');
  });
  test.each([
    'pin',
    'reference',
    'throttle',
    'server-error',
  ])('%s never causes a cross-account replay', async (kind) => {
    let calls = 0;
    const f = await proxyFixture(() => {
      calls++;
      return Response.json(
        {
          error: {
            type:
              kind === 'throttle'
                ? 'rate_limit_exceeded'
                : 'usage_limit_reached',
          },
        },
        { status: kind === 'server-error' ? 500 : 429 },
      );
    });
    const token = await f.issue('codex', kind === 'pin');
    await (
      await f.request(token, {
        input: 'hello',
        ...(kind === 'reference'
          ? { previous_response_id: 'account-bound' }
          : {}),
      })
    ).text();
    expect(calls).toBe(1);
    expect(authorizedLease(readLeases(f.paths), token).account_key).toBe(
      'codex-1',
    );
    if (kind === 'throttle')
      expect(readPool(f.paths).accounts[0]!.quota_blocks).toEqual({});
  });
  test.each([
    { input: [{ type: 'item_reference', id: 'msg_stored' }] },
    { input: [{ type: 'input_file', file_id: 'file_stored' }] },
    { input: [{ type: 'reasoning', encrypted_content: 'sealed' }] },
    { input: 'hello', conversation: 'conv_stored' },
    { input: 'hello', prompt: { id: 'pmpt_stored' } },
    {
      input: 'hello',
      tools: [{ type: 'file_search', vector_store_ids: ['vs_stored'] }],
    },
  ])('account-bound request objects do not replay: %j', async (body) => {
    let calls = 0;
    const f = await proxyFixture(() => {
      calls++;
      return Response.json(
        { error: { type: 'usage_limit_reached' } },
        { status: 429 },
      );
    });
    const token = await f.issue();
    expect((await f.request(token, body)).status).toBe(429);
    expect(calls).toBe(1);
    expect(authorizedLease(readLeases(f.paths), token).account_key).toBe(
      'codex-1',
    );
  });
  test('quota failover is bounded to three accounts even when more are eligible', async () => {
    const seen: string[] = [];
    const f = await proxyFixture((req) => {
      seen.push(req.headers.get('chatgpt-account-id')!);
      return Response.json(
        { error: { type: 'usage_limit_reached' } },
        { status: 429 },
      );
    });
    await seed(f, [
      managed(),
      managed('codex', 2),
      managed('codex', 3),
      managed('codex', 4),
    ]);
    const response = await f.request(await f.issue());
    expect(response.status).toBe(429);
    await response.body?.cancel();
    expect(new Set(seen).size).toBe(3);
    expect(seen).toHaveLength(3);
    expect(
      readPool(f.paths).accounts.filter((a) => a.quota_blocks.main),
    ).toHaveLength(3);
  });
  test('upstream header timeout never replays and releases request buffers', async () => {
    let calls = 0;
    const f = await proxyFixture(
      async () => {
        calls++;
        await Bun.sleep(100);
        return new Response('late');
      },
      { headerTimeoutMs: 30 },
    );
    const response = await f.request(await f.issue());
    expect(response.status).toBe(502);
    await response.body?.cancel();
    expect(calls).toBe(1);
    expect(f.proxy.activeRequests()).toBe(0);
    expect(f.proxy.bufferedBytes()).toBe(0);
  });
  test('401 retries exactly once against the same refreshed identity', async () => {
    let refreshes = 0,
      attempts = 0;
    const f = await proxyFixture((req) => {
      if (new URL(req.url).pathname === '/oauth/token') {
        refreshes++;
        return Response.json({
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        });
      }
      attempts++;
      return req.headers.get('authorization') === 'Bearer new-token'
        ? new Response('ok')
        : new Response('', { status: 401 });
    });
    const token = await f.issue();
    expect(await (await f.request(token)).text()).toBe('ok');
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
  });
  test('second 401 quarantines only its rejected generation and does not refresh in a loop', async () => {
    let refreshes = 0,
      attempts = 0;
    const f = await proxyFixture((req) => {
      if (new URL(req.url).pathname === '/oauth/token') {
        refreshes++;
        return Response.json({
          access_token: 'still-rejected',
          refresh_token: 'rotated',
          expires_in: 3600,
        });
      }
      attempts++;
      return new Response('', { status: 401 });
    });
    const token = await f.issue();
    expect((await f.request(token)).status).toBe(401);
    expect((await f.request(token)).status).toBe(401);
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
    const account = readPool(f.paths).accounts[0]!;
    expect(account.auth_error).toBe('relogin-required');
    await importAccount(f.paths, 'codex', {
      account_id: account.account_id,
      ...account.credentials,
    });
    await rejectCredential(
      f.paths,
      account.key,
      account.credentials.generation,
    );
    expect(readPool(f.paths).accounts[0]!.auth_error).toBeNull();
  });
  test('stream cancellation, admission cap and idle timeout release counters; no replay after bytes', async () => {
    let calls = 0;
    const f = await proxyFixture(
      () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: started\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      { maxRequests: 1, idleTimeoutMs: 100 },
    );
    const token = await f.issue();
    const response = await f.request(token);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await f.request(token)).status).toBe(503);
    await reader.cancel();
    await Bun.sleep(30);
    expect(f.proxy.activeRequests()).toBe(0);
    expect(f.proxy.bufferedBytes()).toBe(0);
    const again = await f.request(token);
    const pending = again.text().catch(() => 'cancelled');
    await Bun.sleep(200);
    await pending;
    expect(f.proxy.activeRequests()).toBe(0);
    expect(calls).toBe(2);
    await Promise.all([f.proxy.stop(0), f.proxy.stop(0)]);
  });
});
