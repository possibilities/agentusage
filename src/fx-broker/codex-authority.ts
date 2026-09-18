import { createHash } from 'node:crypto';
import { providerHeaders } from '../accounts/credentials.ts';
import { providerURL, readCapped, type Env } from '../accounts/http.ts';
import { AccountError, record } from '../accounts/storage.ts';
import { readPool, type ManagedAccount } from '../accounts/store.ts';
import { SUPPORTED_COLLECTOR_VERSION } from '../catalog/types.ts';
import type { StatePaths } from '../paths.ts';
import { withRoutingEvidenceSnapshot } from '../routing-evidence/projection.ts';
import type { RoutingEvidenceProjection } from '../routing-evidence/types.ts';
import type { FxBrokerAuthority, FxBrokerAuthorityAccount, FxBrokerTarget } from './types.ts';

const MAX_BYTES = 1024 * 1024;
const FRESH_MS = 300_000;
function fail(code: string): never { throw new AccountError(code, code, 409); }
export const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

/** Public evidence is insufficient after a measurement ages or a reset passes. */
export function requireCodexCapacity(evidence: RoutingEvidenceProjection, key: string, now = Date.now()): void {
  const observation = evidence.usage.codex;
  const account = observation.accounts.find(a => a.accountKey === key);
  if (!account || !account.eligible || !account.decisionGrade || account.usageStatus !== 'ok' ||
      account.measuredAtMs === null || account.measuredAtMs > now || now - account.measuredAtMs >= FRESH_MS ||
      observation.observed_at_ms > now || now - observation.observed_at_ms >= FRESH_MS) fail('capacity_unavailable');
  const lane = account.lanes.find(l => l.id === 'main' && l.binding);
  if (!lane?.windows.length || lane.windows.some(w => w.remainingPercent <= 0 ||
      w.resetsAt === null || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now)) fail('capacity_unavailable');
}

function redact(bytes: Uint8Array, account: ManagedAccount): Uint8Array {
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const secret of [account.credentials.access_token, account.credentials.refresh_token, account.account_id, account.email]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return new TextEncoder().encode(text);
}

export function validateCodexCapability(bytes: Uint8Array, model: string, effort: string, tier: string | null): void {
  const value = record(JSON.parse(new TextDecoder().decode(bytes)));
  if (!Array.isArray(value?.models) || value.models.length > 256) fail('catalog_unavailable');
  const matching = value.models.map(record).filter(row => row?.slug === model);
  if (matching.length !== 1) fail('catalog_drift');
  const row = matching[0]!;
  if (row.visibility !== 'list' || row.supported_in_api !== true ||
      !Array.isArray(row.supported_reasoning_levels) ||
      !row.supported_reasoning_levels.some(item => record(item)?.effort === effort)) fail('catalog_drift');
  if (tier !== null && (tier !== 'priority' || !Array.isArray(row.additional_speed_tiers) || !row.additional_speed_tiers.includes('fast'))) fail('catalog_drift');
}

/** Credentials remain exclusively inside AgentUsage. No refresh or inference retry. */
export class CodexFxAuthority implements FxBrokerAuthority {
  private constructor(readonly paths: StatePaths, readonly target: FxBrokerTarget,
    readonly accountKey: string, readonly catalog: Uint8Array, readonly capturedAt: number,
    readonly evidence: RoutingEvidenceProjection, private readonly account: ManagedAccount,
    private readonly env: Env) {}

  static async create(paths: StatePaths, selection: {
    account_key: string; model: string; effort: string; service_tier: string | null;
    expected_source_revision: number | string;
  }, env: Env = process.env): Promise<CodexFxAuthority> {
    return withRoutingEvidenceSnapshot(paths, evidence =>
      CodexFxAuthority.createWithinSnapshot(paths, selection, evidence, env));
  }

  /**
   * Creates an authority while the routing evidence's observation and account
   * locks are held. The bridge uses this to carry one exact revision through
   * durable broker preparation; callers must not retain the snapshot lock over
   * provider inference.
   */
  static async createWithinSnapshot(paths: StatePaths, selection: {
    account_key: string; model: string; effort: string; service_tier: string | null;
    expected_source_revision: number | string;
  }, evidence: RoutingEvidenceProjection, env: Env = process.env): Promise<CodexFxAuthority> {
    if (!/^codex-[1-9]\d*$/.test(selection.account_key) || !/^[a-zA-Z0-9._-]{1,100}$/.test(selection.model) ||
        !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(selection.effort) ||
        ![null, 'priority'].includes(selection.service_tier)) fail('invalid_selection');
    if (String(evidence.source_revision) !== String(selection.expected_source_revision)) fail('source_revision_conflict');
    requireCodexCapacity(evidence, selection.account_key);
    const account = readPool(paths).accounts.find(row => row.key === selection.account_key);
    // Refresh changes the credential/evidence join, so a bridge refuses a
    // credential that cannot remain valid through its bounded first attempt.
    if (!account || account.provider !== 'codex' || !account.enabled || account.auth_error ||
        account.credentials.expires_at_ms <= Date.now() + 240_000) fail('auth_unavailable');
    const signal = AbortSignal.timeout(20_000);
    const response = await fetch(providerURL('codex', `/backend-api/codex/models?client_version=${SUPPORTED_COLLECTOR_VERSION}`, env), {
      headers: providerHeaders(account, new Headers({ accept: 'application/json' })), redirect: 'manual', signal,
    });
    if (response.status !== 200) { await response.body?.cancel(); fail(`catalog_http_${response.status}`); }
    const catalog = redact(await readCapped(response, MAX_BYTES, signal), account);
    validateCodexCapability(catalog, selection.model, selection.effort, selection.service_tier);
    const capturedAt = Date.now();
    const digest = sha256(catalog);
    const target: FxBrokerTarget = {
      target_id: `codex-${selection.model}`, target_revision: digest, provider: 'codex', model: selection.model,
      effort: selection.effort, service_tier: selection.service_tier, protocol: 'openai-responses',
      capability_capture_id: `codex-${capturedAt}`, capability_digest: digest,
    };
    return new CodexFxAuthority(paths, target, selection.account_key, catalog, capturedAt, evidence, structuredClone(account), env);
  }

  /** Exact account facts from the still-held admission snapshot. */
  inspectionWithinSnapshot(): FxBrokerAuthorityAccount {
    return { provider: 'codex', account_key: this.accountKey, account_generation: this.account.ordinal,
      provider_generation: 1, credential_revision: this.account.credentials.generation,
      enabled: this.account.enabled, auth_available: !this.account.auth_error,
      target: this.target, activation_supported: true };
  }

  async inspect(provider: 'codex' | 'grok', key: string): Promise<FxBrokerAuthorityAccount> {
    if (provider !== 'codex' || key !== this.accountKey) fail('adapter_unsupported');
    if (Date.now() - this.capturedAt >= FRESH_MS) fail('capability_stale');
    return withRoutingEvidenceSnapshot(this.paths, evidence => {
      if (evidence.provider_source_revisions.codex < this.evidence.provider_source_revisions.codex) fail('source_revision_conflict');
      requireCodexCapacity(evidence, key);
      const account = readPool(this.paths).accounts.find(a => a.key === key);
      if (!account || account.provider !== 'codex' || account.auth_error || !account.enabled) fail('auth_unavailable');
      return { provider: 'codex' as const, account_key: key, account_generation: account.ordinal, provider_generation: 1,
        credential_revision: account.credentials.generation, enabled: account.enabled, auth_available: true,
        target: this.target, activation_supported: true };
    });
  }

  async forward(binding: FxBrokerAuthorityAccount, request: Parameters<FxBrokerAuthority['forward']>[1]) {
    await this.inspect(binding.provider, binding.account_key);
    if (JSON.stringify(request.target) !== JSON.stringify(this.target)) fail('target_mismatch');
    if (request.operation === 'catalog') return { account_generation: binding.account_generation,
      provider_generation: 1, credential_revision: binding.credential_revision,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: this.catalog } };
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)));
    const reasoning = record(body?.reasoning);
    if (!body || body.model !== this.target.model || reasoning?.effort !== this.target.effort ||
        (body.service_tier ?? null) !== this.target.service_tier || body.store !== false) fail('target_mismatch');
    const signal = AbortSignal.timeout(120_000);
    const {account,response} = await withRoutingEvidenceSnapshot(this.paths, async evidence => {
      if(evidence.provider_source_revisions.codex < this.evidence.provider_source_revisions.codex) fail('source_revision_conflict');
      requireCodexCapacity(evidence, binding.account_key);
      const account=readPool(this.paths).accounts.find(row=>row.key===binding.account_key);
      if(!account || !account.enabled || account.auth_error || account.credentials.generation !== binding.credential_revision) fail('credential_revision_conflict');
      const response = await fetch(providerURL('codex', '/backend-api/codex/responses', this.env), {
        method: 'POST', headers: providerHeaders(account, new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' })),
        body: request.body, redirect: 'manual', signal,
      });
      return {account,response};
    });
    const bytes = redact(await readCapped(response, MAX_BYTES, signal), account);
    return { account_generation: account.ordinal, provider_generation: 1, credential_revision: account.credentials.generation,
      response: { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body: bytes } };
  }
}
