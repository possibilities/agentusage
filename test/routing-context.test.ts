import { describe, expect, test } from 'bun:test';
import {
  coalesceRoutingContext,
  composeRoutingContext,
  consumeRoutingContext,
  planRoutingContextDelivery,
  routingCapabilityDigest,
  type RoutingContextInput,
  type RoutingContextSnapshot,
} from '../src/routing-context/index.ts';
import type { CapabilitySet } from '../src/catalog/types.ts';
import type { FxBrokerBindingReceipt } from '../src/fx-broker/types.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const CAPTURE_ID = '123e4567-e89b-42d3-a456-426614174000';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function capabilities(): CapabilitySet {
  return {
    hidden: false,
    efforts: ['medium', 'high'],
    default_effort: 'medium',
    service_tiers: ['priority'],
    default_service_tier: 'priority',
    is_default: true,
    multi_agent_version: 'v2',
    input_modalities: ['text', 'image'],
  };
}

function nativeRow() {
  return {
    id: 'gpt-test',
    model: 'gpt-test',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'not projected' },
      { reasoningEffort: 'high', description: 'not projected' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['image', 'text'],
    multiAgentVersion: 'v2',
    serviceTiers: [{ id: 'priority', name: 'secret tier copy', description: 'not projected' }],
    additionalSpeedTiers: [],
    defaultServiceTier: 'priority',
    isDefault: true,
  };
}

function account(key: string, remaining = 80) {
  return {
    accountKey: key,
    providerAccountId: `provider-secret-${key}`,
    email: `${key}@secret.test`,
    label: `secret label ${key}`,
    ordinal: Number(key.split('-')[1]),
    enabled: true,
    present: true,
    authStatus: 'ok',
    reloginRequired: false,
    identityConflict: false,
    manuallyDisabled: false,
    usageStatus: 'ok',
    decisionGrade: true,
    planType: 'secret-plan',
    limitReached: false,
    measurementSource: 'current',
    measuredAtMs: NOW - 30_000,
    lanes: [{
      id: 'main',
      title: 'Main',
      binding: true,
      windows: [{
        role: 'primary',
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        resetsAt: '2026-09-16T14:00:00Z',
        resetAfterSeconds: 7_200,
        limitName: null,
        meteredFeature: null,
      }],
    }],
    eligible: remaining > 0,
    exclusions: [],
    headroomPercent: remaining,
    activeLeases: key === 'codex-1' ? 1 : 0,
    nextPollAt: null,
    lastError: null,
    access_token: `ACCESS_SECRET_${key}`,
  };
}

function receipt(accountKey: string, state: 'active' | 'prepared'): FxBrokerBindingReceipt {
  const current = accountKey === 'codex-1';
  return {
    schema_version: 1,
    request_id: `prepare-${accountKey}`,
    lease_id: `lease-${accountKey}`,
    binding_id: `binding-${accountKey}`,
    binding_digest: HEX_A,
    authority_digest: HEX_B,
    broker_incarnation: 'broker-incarnation-1',
    lease_revision: state === 'active' ? 2 : 1,
    state,
    owner: {
      host_id: 'agentfx-host-1',
      host_incarnation: 'agentfx-incarnation-1',
      control_epoch: 4,
      execution_id: 'execution-1',
      attempt_id: current ? 'attempt-1' : `attempt-${accountKey}`,
    },
    account: {
      provider: 'codex',
      account_key: accountKey,
      account_generation: current ? 3 : 7,
      provider_generation: 11,
    },
    target: {
      target_id: 'codex-gpt-test',
      target_revision: 'target-revision-1',
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
      service_tier: 'priority',
      protocol: 'openai-responses',
      capability_capture_id: CAPTURE_ID,
      capability_digest: routingCapabilityDigest(capabilities()),
    },
    issued_at_ms: NOW - 60_000,
    activate_before_ms: NOW + 5 * 60_000,
    expires_at_ms: NOW + 10 * 60_000,
    execution_deadline_ms: NOW + 20 * 60_000,
    native: state === 'active' ? {
      process_instance_id: 'fx-process-1',
      fx_build_revision: 'fx-build-1',
      session_id: 'fx-session-1',
    } : null,
    activation_supported: true,
    terminal_reason: null,
  };
}

function fixture(): RoutingContextInput {
  const row = nativeRow();
  return {
    schema_version: 1,
    producer_generation: 1,
    current: {
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
      service_tier: 'priority',
      broker_lease_id: 'lease-codex-1',
      execution_id: 'execution-1',
      attempt_id: 'attempt-1',
      native: {
        process_instance_id: 'fx-process-1',
        fx_build_revision: 'fx-build-1',
        session_id: 'fx-session-1',
      },
    },
    reviewed: {
      schema_version: 1,
      revision: 9,
      catalog: {
        version: 'reviewed-catalog-9',
        reviewed_at: '2026-09-16T10:00:00Z',
        review_after: '2026-10-16T00:00:00Z',
        sources: ['reviewed-source-ref'],
        models: [{ model_id: 'gpt-test', expected: capabilities() }],
      },
      guidance: [{
        provider: 'codex',
        model_id: 'gpt-test',
        task_fit: ['ordinary_implementation', 'bounded_research'],
        quota_lane_id: 'main',
        remaining_capacity_bands: [0, 25, 50, 75],
        cost_guidance: {
          comparison_scope: 'within_provider',
          basis: 'codex_subscription_schedule_2026_09_14',
          unit: 'relative_subscription_credits',
          relative_units: 1,
        },
      }],
    },
    native_catalog: {
      revision: 5,
      catalog: {
        source: 'codex_app_server_model_list',
        client_version: '0.154.0',
        observed_at: '2026-09-16T11:59:00Z',
        pages: [{ data: [row], nextCursor: null }],
        capture_receipt: {
          schema_version: 1,
          profile: 'stock-codex-app-server-0.154.0',
          capture_id: CAPTURE_ID,
          expected_version: '0.154.0',
          reported_version: '0.154.0',
          started_at: '2026-09-16T11:58:59Z',
          completed_at: '2026-09-16T11:59:00Z',
          complete: true,
          pages: [{ request_id: 2, requested_cursor: null, returned_next_cursor: null, include_hidden: true, limit: 100, model_count: 1 }],
        },
      },
    },
    quota: {
      revision: 14,
      account_generations: [
        { account_key: 'codex-1', account_generation: 3, provider_generation: 11 },
        { account_key: 'codex-2', account_generation: 7, provider_generation: 11 },
      ],
      usage: {
        schema_version: 1,
        generated_at: '2026-09-16T11:59:30Z',
        claude: null,
        grok: null,
        codex: {
          schema_version: 2,
          observed_at_ms: NOW - 30_000,
          health: 'ok',
          dependency: null,
          recommendation: { accountKey: 'codex-1' },
          notes: ['secret provider prose'],
          accounts: [account('codex-1'), account('codex-2', 55)],
        },
      },
    },
    broker_receipts: [receipt('codex-1', 'active'), receipt('codex-2', 'prepared')],
    hud: {
      schema_version: 1,
      host: {
        kind: 'host',
        id: 'agentfx-host-1',
        revision: 3,
        owner: 'agentfx-owner',
        serverId: 'agentfx-server-1',
        historyNamespace: 'agentfx-history-1',
        incarnation: 'agentfx-incarnation-1',
        active: true,
      },
      domain: {
        kind: 'domain',
        id: 'agentfx-domain-1',
        revision: 4,
        hostId: 'agentfx-host-1',
        target: { kind: 'fx_session', id: 'fx-session-1' },
        controllerId: 'agenthud-controller-1',
        controlEpoch: 4,
        allowedActions: ['start', 'steer', 'interrupt'],
        scopeId: 'routing-scope-1',
        active: true,
      },
    },
  };
}

function composed(input = fixture(), previous: RoutingContextSnapshot | null = null, now = NOW): RoutingContextSnapshot {
  const result = composeRoutingContext(input, previous, now);
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.subject}`);
  return result.snapshot;
}

describe('routing context composer', () => {
  test('joins reviewed guidance, exact native capability, fresh quota, broker and HUD identity without secrets', () => {
    const result = composeRoutingContext(fixture(), null, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('published');
    expect(result.snapshot).toMatchObject({
      schema_version: 1,
      context_revision: 1,
      trigger: 'initial',
      current: { model: 'gpt-test', effort: 'high', service_tier: 'priority' },
      guidance: { quota_lane_id: 'main', cost_guidance: { comparison_scope: 'within_provider', relative_units: 1 } },
      native_catalog: { capture_id: CAPTURE_ID },
      host_control: { host_id: 'agentfx-host-1', control_epoch: 4 },
      quota: { routing_available: true, eligible_account_keys: ['codex-1', 'codex-2'] },
    });
    expect(result.snapshot.quota.accounts[0]).toMatchObject({ account_key: 'codex-1', account_generation: 3, broker_state: 'active' });
    expect(result.snapshot.quota.accounts[1]).toMatchObject({ account_key: 'codex-2', account_generation: 7, broker_state: 'prepared' });
    const text = JSON.stringify(result.snapshot);
    for (const secret of ['secret.test', 'provider-secret', 'ACCESS_SECRET', 'secret-plan', 'secret provider prose', 'secret tier copy']) {
      expect(text).not.toContain(secret);
    }
  });

  test('never advertises absent or unhealthy accounts and rejects non-boolean eligibility fields', () => {
    const unavailable = fixture();
    const second = (unavailable.quota.usage.codex as any).accounts[1]!;
    second.present = false;
    second.usageStatus = 'error';
    const result = composeRoutingContext(unavailable, null, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.quota.accounts[1]).toMatchObject({ eligible: false });

    const malformed = fixture();
    (malformed.quota.usage.codex as any).accounts[0]!.eligible = 1;
    expect(composeRoutingContext(malformed, null, NOW)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  test('coalesces identical evidence, publishes a heartbeat for a fresh source revision, and marks quota changes material', () => {
    const first = composed();
    const identical = composeRoutingContext(fixture(), first, NOW + 1_000);
    expect(identical).toEqual({ ok: true, action: 'coalesced', snapshot: first });

    const heartbeatInput = fixture();
    heartbeatInput.quota.revision = Number(heartbeatInput.quota.revision) + 1;
    heartbeatInput.quota.usage.generated_at = '2026-09-16T12:00:30Z';
    (heartbeatInput.quota.usage.codex as any).observed_at_ms = NOW + 30_000;
    for (const row of (heartbeatInput.quota.usage.codex as any).accounts) row.measuredAtMs = NOW + 30_000;
    const heartbeat = composeRoutingContext(heartbeatInput, first, NOW + 30_000);
    expect(heartbeat.ok && heartbeat.snapshot).toMatchObject({ context_revision: 2, trigger: 'heartbeat' });

    const withinBandInput = structuredClone(heartbeatInput);
    withinBandInput.quota.revision = Number(withinBandInput.quota.revision) + 1;
    withinBandInput.quota.usage.generated_at = '2026-09-16T12:00:45Z';
    (withinBandInput.quota.usage.codex as any).observed_at_ms = NOW + 45_000;
    const withinBandAccount = (withinBandInput.quota.usage.codex as any).accounts[1]!;
    withinBandAccount.measuredAtMs = NOW + 45_000;
    withinBandAccount.lanes[0]!.windows[0]!.usedPercent = 46;
    withinBandAccount.lanes[0]!.windows[0]!.remainingPercent = 54;
    const withinBand = composeRoutingContext(withinBandInput, heartbeat.ok ? heartbeat.snapshot : first, NOW + 45_000);
    expect(withinBand.ok && withinBand.snapshot).toMatchObject({ context_revision: 3, trigger: 'heartbeat' });

    const changedInput = structuredClone(withinBandInput);
    changedInput.quota.revision = Number(changedInput.quota.revision) + 1;
    changedInput.quota.usage.generated_at = '2026-09-16T12:01:00Z';
    (changedInput.quota.usage.codex as any).observed_at_ms = NOW + 60_000;
    const changedAccount = (changedInput.quota.usage.codex as any).accounts[1]!;
    changedAccount.measuredAtMs = NOW + 60_000;
    changedAccount.lanes[0]!.windows[0]!.usedPercent = 100;
    changedAccount.lanes[0]!.windows[0]!.remainingPercent = 0;
    changedAccount.eligible = false;
    const changed = composeRoutingContext(changedInput, withinBand.ok ? withinBand.snapshot : first, NOW + 60_000);
    expect(changed.ok && changed.snapshot).toMatchObject({ context_revision: 4, trigger: 'material_change' });
    if (changed.ok) expect(changed.snapshot.quota.eligible_account_keys).toEqual(['codex-1']);
  });

  test.each([
    ['reviewed_metadata_stale', (input: RoutingContextInput) => { input.reviewed.catalog.review_after = '2026-09-16T12:00:00Z'; }],
    ['native_catalog_stale', (input: RoutingContextInput) => {
      input.native_catalog.catalog.observed_at = '2026-09-16T11:54:59Z';
      input.native_catalog.catalog.capture_receipt!.started_at = '2026-09-16T11:54:58Z';
      input.native_catalog.catalog.capture_receipt!.completed_at = '2026-09-16T11:54:59Z';
    }],
    ['quota_evidence_stale', (input: RoutingContextInput) => { input.quota.usage.generated_at = '2026-09-16T11:54:59Z'; }],
    ['broker_receipt_stale', (input: RoutingContextInput) => {
      input.broker_receipts[0]!.activate_before_ms = NOW - 1;
      input.broker_receipts[0]!.expires_at_ms = NOW;
    }],
    ['capability_join_mismatch', (input: RoutingContextInput) => { input.current.effort = 'ultra'; }],
    ['account_join_mismatch', (input: RoutingContextInput) => { input.current.attempt_id = 'wrong-attempt'; }],
    ['account_join_mismatch', (input: RoutingContextInput) => { input.quota.account_generations[0]!.account_generation += 1; }],
    ['host_control_join_mismatch', (input: RoutingContextInput) => { input.hud.domain.target.id = 'other-session'; }],
    ['ambiguous_join', (input: RoutingContextInput) => { input.broker_receipts.push(structuredClone(input.broker_receipts[1]!)); }],
  ] as const)('fails closed with %s', (code, mutate) => {
    const input = fixture();
    mutate(input);
    expect(composeRoutingContext(input, null, NOW)).toMatchObject({ ok: false, error: { code } });
  });

  test('refuses source revision rollback and same-revision evidence conflicts', () => {
    const first = composed();
    const regressed = fixture();
    regressed.quota.revision = Number(regressed.quota.revision) - 1;
    expect(composeRoutingContext(regressed, first, NOW)).toMatchObject({ ok: false, error: { code: 'source_revision_regressed' } });
    const conflict = fixture();
    (conflict.quota.usage.codex as any).accounts[1]!.activeLeases = 2;
    expect(composeRoutingContext(conflict, first, NOW)).toMatchObject({ ok: false, error: { code: 'source_revision_conflict' } });

    const hudConflict = fixture();
    hudConflict.hud.host.serverId = 'changed-without-host-revision';
    hudConflict.hud.domain.revision += 1;
    expect(composeRoutingContext(hudConflict, first, NOW)).toMatchObject({ ok: false, error: { code: 'source_revision_conflict' } });

    const brokerConflict = fixture();
    brokerConflict.broker_receipts[0]!.authority_digest = 'c'.repeat(64);
    brokerConflict.broker_receipts[1]!.lease_revision += 1;
    expect(composeRoutingContext(brokerConflict, first, NOW)).toMatchObject({ ok: false, error: { code: 'source_revision_conflict' } });
  });

  test('accepts lossless multi-provider revisions and ignores Grok accounts for Codex routing', () => {
    const input = fixture();
    input.quota.revision = '6385791490841077170325537';
    input.quota.usage.grok = {
      schema_version: 1,
      observed_at_ms: NOW - 20_000,
      health: 'ok',
      dependency: null,
      notes: [],
      accounts: [{ accountKey: 'grok-2' }],
    };
    input.quota.account_generations.push({
      account_key: 'grok-2',
      account_generation: 2,
      provider_generation: 1,
    });
    const first = composed(input);
    expect(first.sources.quota_revision).toBe('6385791490841077170325537');
    expect(first.quota.accounts.map((account) => account.account_key)).toEqual([
      'codex-1',
      'codex-2',
    ]);

    const advanced = structuredClone(input);
    advanced.quota.revision = '6385791490841077170325538';
    const next = composeRoutingContext(advanced, first, NOW + 1);
    expect(next.ok).toBe(true);

    const regressed = structuredClone(input);
    regressed.quota.revision = '6385791490841077170325536';
    expect(composeRoutingContext(regressed, first, NOW + 1)).toMatchObject({
      ok: false,
      error: { code: 'source_revision_regressed' },
    });
  });

  test('treats the five-minute boundary as expired and accepts monotonic HUD domain changes', () => {
    const boundary = fixture();
    boundary.native_catalog.catalog.observed_at = '2026-09-16T11:55:00Z';
    boundary.native_catalog.catalog.capture_receipt!.started_at = '2026-09-16T11:54:59Z';
    boundary.native_catalog.catalog.capture_receipt!.completed_at = '2026-09-16T11:55:00Z';
    expect(composeRoutingContext(boundary, null, NOW)).toMatchObject({ ok: false, error: { code: 'native_catalog_stale' } });

    const first = composed();
    const transferred = fixture();
    transferred.hud.domain.revision += 1;
    transferred.hud.domain.controlEpoch += 1;
    for (const item of transferred.broker_receipts) {
      item.owner.control_epoch += 1;
      item.lease_revision += 1;
    }
    const result = composeRoutingContext(transferred, first, NOW);
    expect(result.ok && result.snapshot).toMatchObject({ context_revision: 2, trigger: 'static_change' });

    const deadline = fixture();
    deadline.native_catalog.catalog.observed_at = '2026-09-16T12:00:00Z';
    deadline.native_catalog.catalog.capture_receipt!.started_at = '2026-09-16T11:59:59Z';
    deadline.native_catalog.catalog.capture_receipt!.completed_at = '2026-09-16T12:00:00Z';
    deadline.quota.usage.generated_at = '2026-09-16T12:00:00Z';
    (deadline.quota.usage.codex as any).observed_at_ms = NOW;
    for (const row of (deadline.quota.usage.codex as any).accounts) row.measuredAtMs = NOW;
    deadline.broker_receipts[1]!.activate_before_ms = NOW + 2 * 60_000;
    expect(composed(deadline).expires_at).toBe('2026-09-16T12:02:00.000Z');
  });

  test('coalesces latest wins and forces full snapshots after gaps, generation changes, and static changes', () => {
    const first = composed();
    const mutableInput = fixture();
    mutableInput.quota.revision = Number(mutableInput.quota.revision) + 1;
    mutableInput.quota.usage.generated_at = '2026-09-16T12:00:10Z';
    (mutableInput.quota.usage.codex as any).observed_at_ms = NOW + 10_000;
    for (const row of (mutableInput.quota.usage.codex as any).accounts) row.measuredAtMs = NOW + 10_000;
    const second = composed(mutableInput, first, NOW + 10_000);
    expect(planRoutingContextDelivery(null, first)).toMatchObject({ mode: 'full', reason: 'initial' });
    expect(planRoutingContextDelivery(first, second)).toMatchObject({ mode: 'delta', reason: 'sequential_mutable_update' });
    expect(planRoutingContextDelivery(second, second)).toMatchObject({ mode: 'none', reason: 'already_current' });

    const thirdInput = structuredClone(mutableInput);
    thirdInput.quota.revision = Number(thirdInput.quota.revision) + 1;
    thirdInput.quota.usage.generated_at = '2026-09-16T12:00:20Z';
    (thirdInput.quota.usage.codex as any).observed_at_ms = NOW + 20_000;
    for (const row of (thirdInput.quota.usage.codex as any).accounts) row.measuredAtMs = NOW + 20_000;
    const third = composed(thirdInput, second, NOW + 20_000);
    expect(planRoutingContextDelivery(first, third)).toMatchObject({ mode: 'full', reason: 'revision_gap' });

    const generationInput = structuredClone(thirdInput);
    generationInput.producer_generation = 2;
    const generation = composed(generationInput, third, NOW + 20_000);
    expect(planRoutingContextDelivery(third, generation)).toMatchObject({ mode: 'full', reason: 'producer_generation_change' });

    const staticInput = fixture();
    staticInput.reviewed.revision += 1;
    const staticChange = composed(staticInput, first, NOW);
    expect(planRoutingContextDelivery(first, staticChange)).toMatchObject({ mode: 'full', reason: 'static_change' });

    const brokerInput = fixture();
    brokerInput.broker_receipts[0]!.lease_revision += 1;
    brokerInput.broker_receipts[0]!.expires_at_ms += 1_000;
    const brokerChange = composed(brokerInput, first, NOW);
    expect(planRoutingContextDelivery(first, brokerChange)).toMatchObject({ mode: 'full', reason: 'static_change' });
    expect(coalesceRoutingContext(second, first)).toBe(second);
    expect(coalesceRoutingContext(first, second)).toBe(second);
    expect(() => coalesceRoutingContext(first, { ...first, digest: '0'.repeat(64) })).toThrow('context_revision_conflict');
    const resetGeneration = composed({ ...fixture(), producer_generation: 2 });
    expect(coalesceRoutingContext(third, resetGeneration)).toBe(resetGeneration);
    expect(coalesceRoutingContext(resetGeneration, third)).toBe(resetGeneration);
    expect(planRoutingContextDelivery(third, resetGeneration)).toMatchObject({ mode: 'full', reason: 'producer_generation_change' });
  });

  test('emits a deterministic consumed-revision receipt without side effects', () => {
    const first = composed();
    const delivery = planRoutingContextDelivery(null, first);
    if (delivery.mode !== 'full') throw new Error('expected full delivery');
    expect(consumeRoutingContext(delivery, 'agenthud-controller-1', NOW + 1_000)).toEqual({
      schema_version: 1,
      consumer_id: 'agenthud-controller-1',
      producer_generation: 1,
      context_revision: 1,
      context_digest: first.digest,
      delivery_digest: delivery.delivery_digest,
      delivery_mode: 'full',
      consumed_at: '2026-09-16T12:00:01.000Z',
    });
    expect(() => consumeRoutingContext(delivery, 'agenthud-controller-1', Date.parse(first.expires_at))).toThrow('invalid_consumption');

    const nextInput = fixture();
    nextInput.quota.revision = Number(nextInput.quota.revision) + 1;
    nextInput.quota.usage.generated_at = '2026-09-16T12:00:10Z';
    (nextInput.quota.usage.codex as any).observed_at_ms = NOW + 10_000;
    for (const row of (nextInput.quota.usage.codex as any).accounts) row.measuredAtMs = NOW + 10_000;
    const next = composed(nextInput, first, NOW + 10_000);
    const delta = planRoutingContextDelivery(first, next);
    if (delta.mode !== 'delta') throw new Error('expected delta delivery');
    delta.payload.quota.accounts[0]!.active_lease_count += 1;
    expect(() => consumeRoutingContext(delta, 'agenthud-controller-1', NOW + 11_000)).toThrow('context_revision_conflict');
    const forged = planRoutingContextDelivery(first, next);
    if (forged.mode !== 'delta') throw new Error('expected delta delivery');
    forged.digest = 'f'.repeat(64);
    forged.producer_generation += 1;
    expect(() => consumeRoutingContext(forged, 'agenthud-controller-1', NOW + 11_000)).toThrow('context_revision_conflict');
  });
});
