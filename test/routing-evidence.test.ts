import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { accountLock, readPool, changePool } from '../src/accounts/store.ts';
import { lockFile } from '../src/accounts/storage.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { buildGrokObservation } from '../src/grok/observe.ts';
import { lockPath as grokAccountLock, readState as readGrokState } from '../src/grok/store.ts';
import { nextCodexSourceRevision, nextGrokSourceRevision } from '../src/observe.ts';
import {
  readRoutingEvidence,
  RoutingEvidenceError,
} from '../src/routing-evidence/index.ts';
import { writeSidecar } from '../src/sidecar.ts';
import { fixtureState, managed, seed } from './managed-fixtures.ts';
import { account as grokAccount, seedGrok } from './grok-fixtures.ts';

async function seedObservedGrok(
  state: ReturnType<typeof fixtureState>,
  nowMs: number,
) {
  const account = grokAccount(2, undefined, nowMs);
  account.alias = 'private-grok-label';
  account.email = 'private-grok@example.test';
  const observation = buildGrokObservation([account], nowMs);
  observation.source_revision = nextGrokSourceRevision(null, nowMs);
  observation.notes = ['private-grok-provider-note'];
  await seedGrok(state.paths, [account]);
  writeSidecar(state.paths.grokObservation, observation);
  (await lockFile(state.paths.grokRefreshLock, 0))();
  return { account, observation };
}

async function observedState() {
  const state = fixtureState();
  const account = managed('codex', 1, {
    email: 'private@example.test',
    label: 'private-label',
    account_id: 'provider-secret-id',
    subscription_type: 'private-plan',
  });
  account.credentials.access_token = 'ACCESS_SECRET';
  account.credentials.refresh_token = 'REFRESH_SECRET';
  const additional = account.usage!.value.additional_rate_limits as Array<{
    limit_name: string;
    metered_feature: string;
  }>;
  additional[0]!.limit_name = 'ARBITRARY_PRIVATE_STRING_SPARK';
  additional[0]!.metered_feature = 'PRIVATE_FEATURE_SPARK';
  await seed(state, [account]);
  const observation = buildCodexObservation(
    readPool(state.paths).accounts,
    Date.now(),
  );
  observation.notes = ['private-provider-note'];
  writeSidecar(state.paths.codexObservation, observation);
  (await lockFile(state.paths.codexRefreshLock, 0))();
  const grok = await seedObservedGrok(state, observation.observed_at_ms + 1);
  return { state, observation, grok };
}

describe('routing evidence projection', () => {
  test('emits one sanitized composer-ready quota snapshot', async () => {
    const { state, observation, grok } = await observedState();
    const nowMs = observation.observed_at_ms + 100;
    const projection = await readRoutingEvidence(state.paths, nowMs);

    expect(projection).toMatchObject({
      schema_version: 2,
      provider_source_revisions: {
        codex: observation.source_revision,
        grok: grok.observation.source_revision,
      },
      generated_at: new Date(grok.observation.observed_at_ms).toISOString(),
      account_generations: [
        {
          account_key: 'codex-1',
          account_generation: 1,
          provider_generation: 1,
        },
        {
          account_key: 'grok-2',
          account_generation: 2,
          provider_generation: 1,
        },
      ],
      usage: {
        schema_version: 1,
        generated_at: new Date(grok.observation.observed_at_ms).toISOString(),
        claude: null,
        grok: {
          health: 'ok',
          observed_at_ms: grok.observation.observed_at_ms,
          accounts: [{
            accountKey: 'grok-2',
            displayName: 'grok-2',
            alias: null,
            email: null,
            subscriptionTier: null,
          }],
          notes: [],
        },
        codex: {
          health: 'ok',
          observed_at_ms: observation.observed_at_ms,
          accounts: [{ accountKey: 'codex-1', eligible: true }],
          notes: [],
        },
      },
    });
    const encoded = JSON.stringify(projection);
    for (const secret of [
      'ACCESS_SECRET',
      'REFRESH_SECRET',
      'provider-secret-id',
      'private@example.test',
      'private-label',
      'private-plan',
      'private-provider-note',
      'ARBITRARY_PRIVATE_STRING',
      'PRIVATE_FEATURE',
      'private-grok@example.test',
      'private-grok-label',
      'private-grok-provider-note',
      'SuperGrok',
    ]) expect(encoded).not.toContain(secret);
    expect(projection.source_revision).toMatch(/^\d+$/u);
    expect(await readRoutingEvidence(state.paths, nowMs + 60_000)).toEqual(projection);
  });

  test('fails closed when the observation no longer exactly matches the account pool', async () => {
    const { state } = await observedState();
    await changePool(state.paths, (pool) => {
      pool.accounts[0]!.enabled = false;
    });
    await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
      code: 'inconsistent_snapshot',
    });
  });

  test('normalizes arbitrary private error strings before publication', async () => {
    const state = fixtureState();
    const account = managed('codex', 1, {
      auth_error: 'AUTH_ERROR_SECRET',
      usage_error: { code: 'USAGE_ERROR_SECRET', status: 503 },
    });
    await seed(state, [account]);
    writeSidecar(
      state.paths.codexObservation,
      buildCodexObservation(readPool(state.paths).accounts, Date.now()),
    );
    (await lockFile(state.paths.codexRefreshLock, 0))();
    await seedObservedGrok(state, Date.now() + 1);
    const projection = await readRoutingEvidence(state.paths);
    expect(projection.usage.codex.accounts[0]).toMatchObject({
      authStatus: 'relogin-required',
      lastError: { code: 'usage-unavailable', httpStatus: 503, summary: null },
    });
    expect(JSON.stringify(projection)).not.toContain('SECRET');
  });

  test('refuses an eligible measurement from another credential generation', async () => {
    const { state } = await observedState();
    await changePool(state.paths, (pool) => {
      const account = pool.accounts[0]!;
      account.credentials.generation = 2;
      account.usage!.credential_generation = 1;
    });
    const observation = buildCodexObservation(readPool(state.paths).accounts, Date.now());
    writeSidecar(state.paths.codexObservation, observation);
    await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
      code: 'generation_unavailable',
    });
  });

  test('accepts only unambiguous legacy generation-one samples', async () => {
    const state = fixtureState();
    const first = managed();
    delete first.usage!.credential_generation;
    await seed(state, [first]);
    writeSidecar(
      state.paths.codexObservation,
      buildCodexObservation(readPool(state.paths).accounts, Date.now()),
    );
    (await lockFile(state.paths.codexRefreshLock, 0))();
    await seedObservedGrok(state, Date.now() + 1);
    expect((await readRoutingEvidence(state.paths)).account_generations[0])
      .toMatchObject({ provider_generation: 1 });

    await changePool(state.paths, (pool) => {
      pool.accounts[0]!.credentials.generation = 2;
    });
    writeSidecar(
      state.paths.codexObservation,
      buildCodexObservation(readPool(state.paths).accounts, Date.now()),
    );
    await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
      code: 'generation_unavailable',
    });
  });

  test('refuses lock contention rather than mixing a refresh boundary', async () => {
    const { state } = await observedState();
    const release = await lockFile(state.paths.codexRefreshLock, 0);
    try {
      await expect(readRoutingEvidence(state.paths)).rejects.toEqual(
        new RoutingEvidenceError('snapshot_busy'),
      );
    } finally {
      release();
    }
  });

  test('refuses account-pool contention and releases its observation lock', async () => {
    const { state } = await observedState();
    const release = await lockFile(accountLock(state.paths), 0);
    try {
      await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
        code: 'snapshot_busy',
      });
    } finally {
      release();
    }
    expect((await readRoutingEvidence(state.paths)).schema_version).toBe(2);
  });

  test('refuses Grok usage measured under a replaced access token', async () => {
    const { state } = await observedState();
    const grok = await readGrokState(state.paths);
    grok.accounts[0]!.credentials.accessToken = 'rotated-without-refresh';
    await seedGrok(state.paths, grok.accounts);
    writeSidecar(
      state.paths.grokObservation,
      Object.assign(
        buildGrokObservation(grok.accounts, Date.now()),
        { source_revision: Date.now() },
      ),
    );
    await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
      code: 'generation_unavailable',
    });
  });

  test('refuses Grok account-state contention and releases provider locks', async () => {
    const { state } = await observedState();
    const release = await lockFile(grokAccountLock(state.paths), 0);
    try {
      await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
        code: 'snapshot_busy',
      });
    } finally {
      release();
    }
    expect((await readRoutingEvidence(state.paths)).schema_version).toBe(2);
  });

  test('advances source revisions across equal or regressed wall-clock timestamps', () => {
    const observation = buildCodexObservation([managed()], 100);
    observation.source_revision = 200;
    expect(nextCodexSourceRevision(observation, 100)).toBe(201);
    expect(nextCodexSourceRevision(observation, 300)).toBe(300);
    const grok = buildGrokObservation([grokAccount(1)], 100);
    grok.source_revision = 200;
    expect(nextGrokSourceRevision(grok, 100)).toBe(201);
    expect(nextGrokSourceRevision(grok, 300)).toBe(300);
  });

  test('CLI exposes the same one-shot JSON contract without provider access', async () => {
    const { state } = await observedState();
    const result = Bun.spawnSync(
      [process.execPath, `${import.meta.dir}/../src/cli.ts`, 'routing', 'evidence', '--json'],
      { env: { ...process.env, ...state.env }, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    const projection = JSON.parse(result.stdout.toString());
    expect(projection.account_generations).toEqual([
      { account_key: 'codex-1', account_generation: 1, provider_generation: 1 },
      { account_key: 'grok-2', account_generation: 2, provider_generation: 1 },
    ]);
    expect(result.stdout.toString()).not.toContain('provider-secret-id');
    expect(result.stderr.toString()).toBe('');
  });

  test('absent state refuses without creating a routing state tree', async () => {
    const state = fixtureState();
    expect(existsSync(state.paths.codexDir)).toBe(false);
    await expect(readRoutingEvidence(state.paths)).rejects.toMatchObject({
      code: 'evidence_unavailable',
    });
    expect(existsSync(state.paths.codexDir)).toBe(false);
  });
});
