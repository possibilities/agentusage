import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  NATIVE_MANAGER_REVIEWED_VERSION,
  composeNativeManagerRoutingContext,
  composeNativeManagerRoutingContextJson,
  type NativeManagerContextInput,
} from '../src/routing-context/native-manager.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const reviewed = [
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']],
] as const;

function nativeModels() {
  return reviewed.map(([model, efforts], index) => ({
    model,
    efforts: [...efforts],
    service_tiers: ['standard', 'priority'],
    hidden: false,
    default_effort: efforts.includes('medium') ? 'medium' : efforts[0],
    default_service_tier: 'standard',
    is_default: index === 1,
    multi_agent_version: 'v2',
    input_modalities: ['text'],
  }));
}

function codexAccount() {
  return {
    accountKey: 'codex-1', email: null, label: null, ordinal: null, enabled: true, present: true, authStatus: 'ok',
    reloginRequired: false, identityConflict: false, manuallyDisabled: false, usageStatus: 'ok', decisionGrade: true,
    planType: null, limitReached: false, measurementSource: 'current', measuredAtMs: NOW - 10_000,
    lanes: [{
      id: 'main', title: 'Main', binding: true,
      windows: [{ role: 'primary', label: '5h', windowSeconds: 18_000, usedPercent: 20, remainingPercent: 80, resetsAt: '2026-09-16T14:00:00Z', resetAfterSeconds: 7_200, limitName: null, meteredFeature: null }],
    }],
    eligible: true, exclusions: [], headroomPercent: 80, activeLeases: 0, nextPollAt: null, lastError: null,
  };
}

function grokAccount() {
  return {
    accountKey: 'grok-2', displayName: 'grok-2', ordinal: 2, alias: null, email: null, enabled: true, authStatus: 'valid',
    expiresAt: null, billingStatus: 'fresh',
    included: { usedPercent: 0, remainingPercent: 100, periodType: 'monthly', periodStart: '2026-09-01T00:00:00Z', resetsAt: '2026-10-01T00:00:00Z' },
    prepaid: { balanceUsd: null }, payg: { enabled: null, usedUsd: null, capUsd: null, remainingUsd: null },
    subscriptionTier: null, observedAtMs: NOW - 5_000, lastGoodAtMs: NOW - 5_000, stale: false, error: null,
  };
}

function evidenceV2() {
  return {
    schema_version: 2,
    source_revision: '6385791490841077170325537',
    provider_source_revisions: { codex: 17, grok: 23 },
    generated_at: '2026-09-16T11:59:55Z',
    usage: {
      schema_version: 1, generated_at: '2026-09-16T11:59:55Z', claude: null,
      codex: { schema_version: 2, source_revision: 17, observed_at_ms: NOW - 10_000, health: 'ok', dependency: null, recommendation: { accountKey: 'codex-1' }, accounts: [codexAccount()], notes: [] },
      grok: { schema_version: 1, source_revision: 23, observed_at_ms: NOW - 5_000, health: 'ok', dependency: null, accounts: [grokAccount()], notes: [] },
    },
    account_generations: [
      { account_key: 'codex-1', account_generation: 1, provider_generation: 1 },
      { account_key: 'grok-2', account_generation: 2, provider_generation: 1 },
    ],
  };
}

function fixture(): NativeManagerContextInput {
  return {
    schema_version: 1,
    producer_generation: 3,
    context_revision: 7,
    trigger: 'material_change',
    composed_at: '2026-09-16T12:00:00Z',
    reviewed: { revision: 4, source_version: NATIVE_MANAGER_REVIEWED_VERSION },
    native_catalog: {
      revision: 9, source: 'codex_app_server_model_list', client_version: '0.154.0', capture_id: 'native-capture-9',
      observed_at: '2026-09-16T11:59:50Z', models: nativeModels(),
    },
    current: {
      model: 'gpt-5.6-sol', effort: 'medium', service_tier: 'priority',
      native: { process_instance_id: 'voice-process-1', runtime_build_id: 'voice-build-1', session_id: 'voice-root-1' },
    },
    host_control: {
      host_revision: 11, domain_revision: 12, host_id: 'agentvoice-host-1', server_id: 'agentvoice-server-1',
      history_namespace: 'agentvoice-history-1', host_incarnation: 'agentvoice-incarnation-1', domain_id: 'agentvoice-domain-1',
      controller_id: 'agentvoice-controller-1', control_epoch: 2, target: { kind: 'codex_root', id: 'voice-root-1' },
      scope_id: 'voice-routing-1', allowed_actions: ['start', 'steer', 'interrupt'],
    },
    evidence: evidenceV2(),
  };
}

function composed(input = fixture()) {
  const result = composeNativeManagerRoutingContext(input, NOW);
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.subject}`);
  return result.context;
}

describe('native manager routing context', () => {
  test('composes an exact schema-2, digest-fenced snapshot with honest native limitations', () => {
    const context = composed();
    expect(context).toMatchObject({
      schema_version: 2, producer_generation: 3, context_revision: 7, trigger: 'material_change',
      current: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', service_tier: 'priority', account_correlation: 'unavailable', execution_id: null, attempt_id: null, broker_lease_id: null },
      sources: { quota_revision: '6385791490841077170325537', broker_incarnation: 'unavailable', broker_lease_revisions: [] },
      guidance: { reviewed_version: NATIVE_MANAGER_REVIEWED_VERSION, task_fit: ['implementation'], cost_guidance: null, economics_status: 'unavailable' },
      native_catalog: { source: 'codex_app_server_model_list', client_version: '0.154.0', drift: [] },
      host_control: { target: { kind: 'codex_root', id: 'voice-root-1' } },
      quota: { current_account_key: null, routing_available: false, delegation_available: true, eligible_account_keys: ['codex-1', 'grok-2'] },
    });
    expect(context.native_catalog.models.map((row) => row.model)).toEqual([...reviewed.map(([model]) => model)].sort());
    expect(context.guidance.models).toHaveLength(5);
    expect(context.quota.accounts[0]).toMatchObject({ account_key: 'codex-1', broker_lease_id: null, broker_state: null, eligible: true });
    expect(context.quota.grok[0]).toMatchObject({ accountKey: 'grok-2', alias: null, email: null, subscriptionTier: null });
    expect(context.digest).toBe(digest({ ...context, digest: '' }));
    const evidence = fixture().evidence as ReturnType<typeof evidenceV2>;
    expect(context.source_digests.quota).toBe(digest({ revision: evidence.source_revision, usage: evidence.usage, account_generations: evidence.account_generations }));
    expect(JSON.stringify(context)).not.toContain('lease-');
  });

  test('accepts legacy v1 Codex evidence and preserves its numeric source revision', () => {
    const input = fixture();
    const current = input.evidence as ReturnType<typeof evidenceV2>;
    input.evidence = {
      schema_version: 1, source_revision: 17, generated_at: current.generated_at,
      usage: { ...current.usage, grok: null },
      account_generations: [current.account_generations[0]],
    };
    const context = composed(input);
    expect(context.sources.quota_revision).toBe(17);
    expect(context.quota.grok).toEqual([]);
    expect(context.quota.eligible_account_keys).toEqual(['codex-1']);
  });

  test('uses the native list as authority and suppresses recommendations on reviewed drift', () => {
    const input = fixture();
    input.native_catalog.models.find((row) => row.model === 'gpt-5.6-luna')!.efforts.push('ultra');
    const context = composed(input);
    expect(context.native_catalog.drift).toEqual(['effort-mismatch:gpt-5.6-luna']);
    expect(context.guidance.models).toEqual([]);
    expect(context.quota.eligible_account_keys).toEqual(['codex-1', 'grok-2']);
    expect(context.quota.delegation_available).toBe(false);

    const currentMismatch = fixture();
    currentMismatch.current.effort = 'unsupported';
    expect(composed(currentMismatch).native_catalog.drift).toContain('current-effort-mismatch:gpt-5.6-sol');
  });

  test('does not infer a standard tier when the native catalog reports only priority', () => {
    const input = fixture();
    input.current.service_tier = null;
    for (const row of input.native_catalog.models) {
      row.service_tiers = ['priority'];
      row.default_service_tier = 'priority';
    }
    expect(composed(input).native_catalog.drift).toEqual([]);
  });

  test('preserves unreviewed hidden native models without disabling reviewed targets', () => {
    const input = fixture();
    for (const model of ['gpt-reserve', 'codex-auto-review']) {
      input.native_catalog.models.push({
        model,
        efforts: ['medium'],
        service_tiers: ['priority'],
        hidden: true,
        default_effort: 'medium',
        default_service_tier: null,
        is_default: false,
        multi_agent_version: null,
        input_modalities: ['text'],
      });
    }
    const context = composed(input);
    expect(context.native_catalog.drift).toEqual([]);
    expect(context.native_catalog.models.filter((row) => row.hidden).map((row) => row.model)).toEqual([
      'codex-auto-review',
      'gpt-reserve',
    ]);
    expect(context.guidance.models).toHaveLength(5);
    expect(context.quota.delegation_available).toBe(true);
  });

  test('keeps fresh positive included Grok independently eligible when Codex evidence is stale', () => {
    const input = fixture();
    const codex = (input.evidence as ReturnType<typeof evidenceV2>).usage.codex;
    codex.observed_at_ms = NOW - 5 * 60_000;
    codex.accounts[0]!.measuredAtMs = NOW - 5 * 60_000;
    (input.evidence as ReturnType<typeof evidenceV2>).usage.grok.accounts[0]!.included!.remainingPercent = 37;
    const context = composed(input);
    expect(context.quota.eligible_account_keys).toEqual(['grok-2']);
    expect(context.quota.accounts[0]).toMatchObject({ eligible: false, decision_grade: false });
    expect(context.quota.accounts[0]!.exclusions).toEqual(expect.arrayContaining(['stale_measurement', 'stale_observation']));
  });

  test('fails account eligibility closed after a reset boundary and exhausted Grok included quota', () => {
    const input = fixture();
    const evidence = input.evidence as ReturnType<typeof evidenceV2>;
    evidence.usage.codex.accounts[0]!.lanes[0]!.windows[0]!.resetsAt = '2026-09-16T11:59:58Z';
    evidence.usage.grok.accounts[0]!.included!.remainingPercent = 0;
    const context = composed(input);
    expect(context.quota.eligible_account_keys).toEqual([]);
    expect(context.quota.delegation_available).toBe(false);
    expect(context.quota.accounts[0]).toMatchObject({ eligible: false, decision_grade: false });
  });

  test('refuses stale envelopes and ambiguous account or generation joins', () => {
    const stale = fixture();
    (stale.evidence as ReturnType<typeof evidenceV2>).generated_at = '2026-09-16T11:55:00Z';
    (stale.evidence as ReturnType<typeof evidenceV2>).usage.generated_at = '2026-09-16T11:55:00Z';
    expect(composeNativeManagerRoutingContext(stale, NOW)).toMatchObject({ ok: false, error: { code: 'quota_evidence_stale' } });

    const duplicate = fixture();
    const evidence = duplicate.evidence as ReturnType<typeof evidenceV2>;
    evidence.account_generations.push({ ...evidence.account_generations[0]! });
    expect(composeNativeManagerRoutingContext(duplicate, NOW)).toMatchObject({ ok: false, error: { code: 'ambiguous_evidence' } });

    const unjoined = fixture();
    (unjoined.evidence as ReturnType<typeof evidenceV2>).account_generations.pop();
    expect(composeNativeManagerRoutingContext(unjoined, NOW)).toMatchObject({ ok: false, error: { code: 'ambiguous_evidence' } });
  });

  test('is deterministic and the JSON seam rejects malformed or secret-bearing evidence', () => {
    const first = composed();
    expect(composed()).toEqual(first);
    const revised = fixture();
    revised.context_revision += 1;
    expect(composed(revised).digest).not.toBe(first.digest);
    expect(JSON.parse(composeNativeManagerRoutingContextJson('{', NOW))).toEqual({ ok: false, error: { code: 'invalid_input', subject: null } });

    const privateField = fixture() as unknown as Record<string, any>;
    privateField.evidence.usage.codex.accounts[0].access_token = 'SECRET';
    const result = JSON.parse(composeNativeManagerRoutingContextJson(JSON.stringify(privateField), NOW));
    expect(result).toEqual({ ok: false, error: { code: 'invalid_input', subject: null } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  test('requires exact root identity and exact reviewed source version', () => {
    const wrongRoot = fixture();
    wrongRoot.host_control.target.id = 'another-root';
    expect(composeNativeManagerRoutingContext(wrongRoot, NOW)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });

    const wrongReview = fixture() as unknown as Record<string, any>;
    wrongReview.reviewed.source_version = 'approximate-role-catalog';
    expect(composeNativeManagerRoutingContext(wrongReview, NOW)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});
