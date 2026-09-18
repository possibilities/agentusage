import { expect, test } from 'bun:test';
import { accountLock, readPool } from '../src/accounts/store.ts';
import { lockFile } from '../src/accounts/storage.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { GrokFxAuthority } from '../src/fx-broker/grok-authority.ts';
import { buildGrokObservation } from '../src/grok/observe.ts';
import { lockPath as grokAccountLock } from '../src/grok/store.ts';
import { nextGrokSourceRevision } from '../src/observe.ts';
import {
  readRoutingEvidence,
  withRoutingEvidenceSnapshotForAdmission,
} from '../src/routing-evidence/projection.ts';
import { writeSidecar } from '../src/sidecar.ts';
import { fixtureState, managed, seed } from './managed-fixtures.ts';
import { account, billing, seedGrok } from './grok-fixtures.ts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function fixture() {
  const state = fixtureState();
  await seed(state, [managed()]);
  writeSidecar(
    state.paths.codexObservation,
    buildCodexObservation(readPool(state.paths).accounts, Date.now()),
  );
  (await lockFile(state.paths.codexRefreshLock, 0))();
  const now = Date.now();
  const row = account(2, billing({ included: {
    usedPercent: 0,
    remainingPercent: 100,
    periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
    periodStart: new Date(now - 1_000).toISOString(),
    resetsAt: new Date(now + 86_400_000).toISOString(),
  } }), now);
  await seedGrok(state.paths, [row]);
  const observation = buildGrokObservation([row], now);
  observation.source_revision = nextGrokSourceRevision(null, now);
  writeSidecar(state.paths.grokObservation, observation);
  (await lockFile(state.paths.grokRefreshLock, 0))();
  const evidence = await readRoutingEvidence(state.paths);
  let inferenceCalls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/models')
      return Response.json({ data: [{ model: 'grok-test', api_backend: 'responses', supports_reasoning_effort: true,
        reasoning_efforts: [{ value: 'low' }], context_window: 100_000, max_completion_tokens: 8_192 }] });
    if (path === '/v1/language-models')
      return Response.json({ models: [{ id: 'grok-test', input_modalities: ['text'], output_modalities: ['text'] }] });
    inferenceCalls += 1;
    return Response.json({ id: `response-${inferenceCalls}` });
  } });
  const authority = await GrokFxAuthority.create(state.paths, {
    account_key: 'grok-2', model: 'grok-test', effort: 'low', service_tier: null,
    expected_source_revision: evidence.source_revision,
  }, { ...state.env, AGENTUSAGE_TEST_GROK_ORIGIN: `http://127.0.0.1:${server.port}` });
  const binding = await authority.inspect('grok', 'grok-2');
  const request = {
    operation: 'inference' as const,
    target: authority.target,
    headers: {},
    body: bytes({ model: 'grok-test', store: false, reasoning: { effort: 'low' } }),
  };
  return { state, authority, binding, request, server, inferenceCalls: () => inferenceCalls };
}

test('managed inference waits across contention on every snapshot lock and calls the provider once', async () => {
  for (const lockName of ['codex-refresh', 'grok-refresh', 'codex-account', 'grok-account'] as const) {
    const context = await fixture();
    const lockPath = lockName === 'codex-refresh'
      ? context.state.paths.codexRefreshLock
      : lockName === 'grok-refresh'
        ? context.state.paths.grokRefreshLock
        : lockName === 'codex-account'
          ? accountLock(context.state.paths)
          : grokAccountLock(context.state.paths);
    const release = await lockFile(lockPath, 0);
    try {
      const admission = context.authority.forward(context.binding, {
        ...context.request,
        execution_deadline_ms: Date.now() + 10_000,
      });
      await Bun.sleep(40);
      release();
      expect((await admission).response.status).toBe(200);
      expect(context.inferenceCalls()).toBe(1);
    } finally {
      release();
      context.server.stop(true);
    }
  }
}, 30_000);

test('a waited admission reads the post-contention snapshot instead of stale capacity', async () => {
  const context = await fixture();
  const release = await lockFile(context.state.paths.codexRefreshLock, 0);
  try {
    const admission = context.authority.forward(context.binding, {
      ...context.request,
      execution_deadline_ms: Date.now() + 10_000,
    });
    await Bun.sleep(40);
    const now = Date.now();
    const exhausted = account(2, billing({ included: {
      usedPercent: 100,
      remainingPercent: 0,
      periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
      periodStart: new Date(now - 1_000).toISOString(),
      resetsAt: new Date(now + 86_400_000).toISOString(),
    } }), now);
    await seedGrok(context.state.paths, [exhausted]);
    const observation = buildGrokObservation([exhausted], now);
    observation.source_revision = nextGrokSourceRevision(null, now);
    writeSidecar(context.state.paths.grokObservation, observation);
    release();
    await expect(admission).rejects.toMatchObject({ code: 'capacity_unavailable' });
    expect(context.inferenceCalls()).toBe(0);
  } finally {
    release();
    context.server.stop(true);
  }
});

test('exhausted or cancelled snapshot acquisition never enters the provider callback', async () => {
  const context = await fixture();
  const release = await lockFile(context.state.paths.grokRefreshLock, 0);
  try {
    let callbacks = 0;
    await expect(withRoutingEvidenceSnapshotForAdmission(context.state.paths, () => {
      callbacks += 1;
    }, { deadline_ms: Date.now() + 1_000, max_wait_ms: 60 })).rejects.toMatchObject({ code: 'snapshot_busy' });
    expect(callbacks).toBe(0);

    const controller = new AbortController();
    const cancelled = context.authority.forward(context.binding, {
      ...context.request,
      execution_deadline_ms: Date.now() + 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(context.inferenceCalls()).toBe(0);

    await expect(context.authority.forward(context.binding, {
      ...context.request,
      execution_deadline_ms: Date.now() + 60,
    })).rejects.toMatchObject({ code: 'expired' });
    expect(context.inferenceCalls()).toBe(0);
  } finally {
    release();
    context.server.stop(true);
  }
});
