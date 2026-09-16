import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditCatalog, CatalogInputError, readBoundedJson, validateCatalogAuditInput } from '../src/catalog/index.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true }); });

function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    hidden: false,
    efforts: ['medium', 'low'],
    default_effort: 'medium',
    service_tiers: ['priority'],
    default_service_tier: 'priority',
    is_default: true,
    multi_agent_version: 'v2',
    input_modalities: ['image', 'text'],
    ...overrides,
  };
}

function nativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'display-row-id',
    model: 'gpt-test',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'secret-like prose is ignored' },
      { reasoningEffort: 'medium', description: 'ignored' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    multiAgentVersion: 'v2',
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'ignored' }],
    additionalSpeedTiers: ['deprecated-tier'],
    defaultServiceTier: 'priority',
    isDefault: true,
    ...overrides,
  };
}

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    metadata: {
      version: '2026-09-16',
      reviewed_at: '2026-09-16T10:00:00Z',
      review_after: '2026-10-16T00:00:00Z',
      sources: ['codex source checkout'],
      models: [{ model_id: 'gpt-test', expected: capabilities() }],
    },
    native_catalog: {
      source: 'codex_app_server_model_list',
      client_version: '1.2.3',
      observed_at: '2026-09-16T11:59:00Z',
      pages: [{ data: [nativeRow()], nextCursor: null }],
    },
    usage: null,
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
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
      notes: [],
      accounts: [{
        accountKey: 'codex-1', providerAccountId: 'provider-secret', email: 'secret@example.test', label: 'secret label', ordinal: 1,
        enabled: true, present: true, authStatus: 'ok', reloginRequired: false, identityConflict: false, manuallyDisabled: false,
        usageStatus: 'ok', decisionGrade: true, planType: 'secret-plan', limitReached: false,
        measurementSource: 'current', measuredAtMs: NOW - 30_000,
        lanes: [{ id: 'main', title: 'Main', binding: true, windows: [{ role: 'primary', label: '5h', windowSeconds: 18000, usedPercent: 20, remainingPercent: 80, resetsAt: '2026-09-16T14:00:00Z', resetAfterSeconds: 7200, limitName: null, meteredFeature: null }] }],
        eligible: true, exclusions: [], headroomPercent: 80, activeLeases: 1, nextPollAt: null, lastError: null,
        access_token: 'must-never-appear',
      }],
    },
    ...overrides,
  };
}

describe('offline catalog audit', () => {
  test('normalizes array order and uses model, not display id', () => {
    const report = auditCatalog(validateCatalogAuditInput(bundle()), NOW);
    expect(report.models).toHaveLength(1);
    expect(report.models[0]!.model_id).toBe('gpt-test');
    expect(report.models[0]!.status).toBe('match');
    expect(report.models[0]!.authored!.fingerprint).toBe(report.models[0]!.native!.fingerprint);
    expect(report.models[0]!.native!.service_tier_source).toBe('service_tiers');
  });

  test('reports field drift, live-only metadata, and complete-snapshot absence', () => {
    const input = bundle();
    (input.metadata.models as any[]).push({ model_id: 'reviewed-only', expected: capabilities({ is_default: false }) });
    (input.native_catalog.pages[0]!.data as any[]).push(nativeRow({ model: 'live-only', isDefault: false }));
    (input.native_catalog.pages[0]!.data[0] as any).hidden = true;
    const report = auditCatalog(validateCatalogAuditInput(input), NOW);
    expect(report.models.map((model) => [model.model_id, model.status])).toEqual([
      ['gpt-test', 'capability_drift'], ['live-only', 'metadata_missing'], ['reviewed-only', 'model_unavailable'],
    ]);
    expect(report.models[0]!.changed_fields).toEqual(['hidden']);
  });

  test('partial terminal cursor is diagnostic evidence and cannot prove unavailability', () => {
    const input = bundle();
    input.metadata.models.push({ model_id: 'not-yet-seen', expected: capabilities({ is_default: false }) });
    (input.native_catalog.pages[0] as { nextCursor: string | null }).nextCursor = 'more';
    const report = auditCatalog(validateCatalogAuditInput(input), NOW);
    expect(report.native_catalog.complete).toBe(false);
    expect(report.models.find((model) => model.model_id === 'not-yet-seen')!.status).toBe('evidence_incomplete');
    expect(report.diagnostics.some((item) => item.code === 'native_catalog_incomplete')).toBe(true);
  });

  test('explicit empty serviceTiers is authoritative; absent field uses deprecated fallback', () => {
    const explicit = bundle();
    (explicit.metadata.models[0]!.expected as any).service_tiers = [];
    (explicit.metadata.models[0]!.expected as any).default_service_tier = null;
    Object.assign(explicit.native_catalog.pages[0]!.data[0]!, { serviceTiers: [], defaultServiceTier: null });
    let report = auditCatalog(validateCatalogAuditInput(explicit), NOW);
    expect(report.models[0]!.status).toBe('match');
    const fallback = bundle();
    delete (fallback.native_catalog.pages[0]!.data[0] as any).serviceTiers;
    (fallback.native_catalog.pages[0]!.data[0] as any).additionalSpeedTiers = ['priority'];
    report = auditCatalog(validateCatalogAuditInput(fallback), NOW);
    expect(report.models[0]!.native!.service_tier_source).toBe('deprecated_additional_speed_tiers');
  });

  test('projects quota conservatively and never emits secret-bearing extras', () => {
    const report = auditCatalog(validateCatalogAuditInput(bundle({ usage: usage() })), NOW);
    const text = JSON.stringify(report);
    expect(text).not.toContain('secret@example.test');
    expect(text).not.toContain('provider-secret');
    expect(text).not.toContain('must-never-appear');
    expect(text).not.toContain('recommendation');
    expect((report.quota as any).accounts[0].decision_grade).toBe(true);

    const stale = usage();
    (stale.codex.accounts[0] as any).measurementSource = 'last-good';
    (stale.codex.accounts[0] as any).measuredAtMs = NOW - 600_000;
    const staleReport = auditCatalog(validateCatalogAuditInput(bundle({ usage: stale })), NOW);
    expect((staleReport.quota as any).accounts[0].decision_grade).toBe(false);
    expect(staleReport.diagnostics.some((item) => item.code === 'last_good_measurement')).toBe(true);
  });

  test('rejects duplicate IDs, malformed usage, page gaps, and oversize input', () => {
    const duplicate = bundle();
    duplicate.metadata.models.push(duplicate.metadata.models[0]!);
    expect(() => validateCatalogAuditInput(duplicate)).toThrow(CatalogInputError);
    const malformed = bundle({ usage: usage() });
    (malformed.usage as any).codex.accounts[0].enabled = 'yes';
    expect(() => validateCatalogAuditInput(malformed)).toThrow(CatalogInputError);
    const gap = bundle();
    gap.native_catalog.pages.push({ data: [], nextCursor: null });
    expect(() => validateCatalogAuditInput(gap)).toThrow(CatalogInputError);
    const path = join(tmpdir(), `agentusage-catalog-${crypto.randomUUID()}.json`);
    paths.push(path);
    writeFileSync(path, ' '.repeat(1024 * 1024 + 1));
    expect(() => readBoundedJson(path)).toThrow(new CatalogInputError('input-too-large'));
  });

  test('rejects inconsistent defaults, loose dates, bad account keys, lanes, and percentages', () => {
    const badDate = bundle();
    badDate.metadata.reviewed_at = '0';
    expect(() => validateCatalogAuditInput(badDate)).toThrow(CatalogInputError);
    const impossibleDate = bundle();
    impossibleDate.metadata.reviewed_at = '2026-02-30T12:00:00Z';
    expect(() => validateCatalogAuditInput(impossibleDate)).toThrow(CatalogInputError);
    const badDefault = bundle();
    badDefault.metadata.models[0]!.expected.default_effort = 'ultra';
    expect(() => validateCatalogAuditInput(badDefault)).toThrow(CatalogInputError);
    const duplicateEffort = bundle();
    duplicateEffort.native_catalog.pages[0]!.data[0]!.supportedReasoningEfforts.push({ reasoningEffort: 'low', description: 'duplicate' });
    expect(() => validateCatalogAuditInput(duplicateEffort)).toThrow(CatalogInputError);
    const badUsage = bundle({ usage: usage() });
    (badUsage.usage as any).codex.accounts[0].accountKey = 'provider-account-id';
    expect(() => validateCatalogAuditInput(badUsage)).toThrow(CatalogInputError);
    const duplicateLane = bundle({ usage: usage() });
    (duplicateLane.usage as any).codex.accounts[0].lanes.push((duplicateLane.usage as any).codex.accounts[0].lanes[0]);
    expect(() => validateCatalogAuditInput(duplicateLane)).toThrow(CatalogInputError);
    const badPercent = bundle({ usage: usage() });
    (badPercent.usage as any).codex.accounts[0].lanes[0].windows[0].remainingPercent = 101;
    expect(() => validateCatalogAuditInput(badPercent)).toThrow(CatalogInputError);
  });

  test('health, publication freshness, and crossed resets make reported decision grade ineffective', () => {
    const unhealthy = usage();
    (unhealthy.codex as any).health = 'error';
    let report = auditCatalog(validateCatalogAuditInput(bundle({ usage: unhealthy })), NOW);
    expect((report.quota as any).accounts[0]).toMatchObject({ reported_decision_grade: true, decision_grade: false });
    expect(report.diagnostics.some((item) => item.code === 'usage_health_not_ok')).toBe(true);
    const crossed = usage();
    (crossed.codex.accounts[0] as any).lanes[0].windows[0].resetsAt = '2026-09-16T11:59:45Z';
    report = auditCatalog(validateCatalogAuditInput(bundle({ usage: crossed })), NOW);
    expect((report.quota as any).accounts[0].decision_grade).toBe(false);
    expect(report.diagnostics.some((item) => item.code === 'reset_crossed_refresh_required')).toBe(true);
  });

  test.each([
    ['metadata_review_overdue', (input: any) => { input.metadata.review_after = '2026-09-16T11:59:59Z'; }],
    ['metadata_review_future', (input: any) => {
      input.metadata.reviewed_at = '2026-09-16T12:00:06Z';
      input.metadata.review_after = '2026-10-16T00:00:00Z';
    }],
    ['native_catalog_stale', (input: any) => { input.native_catalog.observed_at = '2026-09-16T11:53:59Z'; }],
    ['native_catalog_future', (input: any) => { input.native_catalog.observed_at = '2026-09-16T12:00:06Z'; }],
    ['usage_stale', (input: any) => { input.usage.generated_at = '2026-09-16T11:53:59Z'; }],
    ['usage_future', (input: any) => { input.usage.generated_at = '2026-09-16T12:00:06Z'; }],
    ['measurement_stale', (input: any) => { input.usage.codex.observed_at_ms = NOW - 361_000; }],
    ['measurement_future', (input: any) => { input.usage.codex.observed_at_ms = NOW + 6_000; }],
  ] as const)('reports %s evidence timing', (code, mutate) => {
    const input = bundle({ usage: usage() });
    mutate(input);
    const report = auditCatalog(validateCatalogAuditInput(input), NOW);
    expect(report.diagnostics.some((item) => item.code === code)).toBe(true);
    if (code.startsWith('usage_') || code.startsWith('measurement_')) {
      expect((report.quota as any).accounts[0].decision_grade).toBe(false);
    }
  });
});
