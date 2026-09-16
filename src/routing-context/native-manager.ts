import { createHash } from 'node:crypto';
import type { CodexAccountView, CodexLane, CodexObservation } from '../codex/types.ts';
import type { GrokAccountView, GrokObservation } from '../grok/types.ts';

export const NATIVE_MANAGER_CONTEXT_SCHEMA_VERSION = 2 as const;
export const NATIVE_MANAGER_INPUT_SCHEMA_VERSION = 1 as const;
export const NATIVE_MANAGER_REVIEWED_VERSION = 'agentvoice-role-catalog-2026-09-14' as const;
export const NATIVE_MANAGER_FRESHNESS_MS = 5 * 60_000;

const FUTURE_TOLERANCE_MS = 5_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/u;
const SOURCE_REVISION = /^[1-9][0-9]{0,63}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX_ACCOUNTS = 512;
const ALLOWED_ACTIONS = new Set(['start', 'steer', 'interrupt']);
const PUBLIC_EXCLUSIONS = new Set([
  'manually_disabled',
  'quota_exhausted',
  'relogin_required',
  'usage_unknown',
]);

const REVIEWED_MODELS = [
  { model: 'gpt-6-astra', task_fit: ['architecture', 'design'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { model: 'gpt-5.6-sol', task_fit: ['implementation'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { model: 'gpt-5.6-terra', task_fit: ['bounded_implementation'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { model: 'gpt-5.6-luna', task_fit: ['narrow_transformations'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { model: 'gpt-5.5', task_fit: ['explicit_preference'], efforts: ['low', 'medium', 'high', 'xhigh'] },
] as const;
const CAPACITY_BANDS = [0, 25, 50, 75, 100] as const;

type SourceRevision = number | string;
type Trigger = 'initial' | 'heartbeat' | 'material_change' | 'static_change' | 'producer_generation_change';

export interface NativeCatalogModel {
  model: string;
  efforts: string[];
  service_tiers: string[];
  hidden: boolean;
  default_effort: string;
  default_service_tier: string | null;
  is_default: boolean;
  multi_agent_version: string | null;
  input_modalities: string[];
}

export interface NativeManagerContextInput {
  schema_version: typeof NATIVE_MANAGER_INPUT_SCHEMA_VERSION;
  producer_generation: number;
  context_revision: number;
  trigger: Trigger;
  composed_at: string;
  reviewed: { revision: number; source_version: typeof NATIVE_MANAGER_REVIEWED_VERSION };
  native_catalog: {
    revision: number;
    source: 'codex_app_server_model_list';
    client_version: string;
    capture_id: string;
    observed_at: string;
    models: NativeCatalogModel[];
  };
  current: {
    model: string | null;
    effort: string | null;
    service_tier: string | null;
    native: { process_instance_id: string; runtime_build_id: string; session_id: string };
  };
  host_control: {
    host_revision: number;
    domain_revision: number;
    host_id: string;
    server_id: string;
    history_namespace: string;
    host_incarnation: string;
    domain_id: string;
    controller_id: string;
    control_epoch: number;
    target: { kind: 'codex_root'; id: string };
    scope_id: string;
    allowed_actions: Array<'start' | 'steer' | 'interrupt'>;
  };
  evidence: unknown;
}

export interface NativeManagerContextSnapshot {
  schema_version: 2;
  producer_generation: number;
  context_revision: number;
  digest: string;
  evidence_digest: string;
  decision_digest: string;
  trigger: Trigger;
  composed_at: string;
  observed_at: string;
  expires_at: string;
  sources: {
    reviewed_revision: number;
    native_catalog_revision: number;
    quota_revision: SourceRevision;
    broker_incarnation: 'unavailable';
    broker_revision_digest: string;
    broker_lease_revisions: [];
    hud_host_revision: number;
    hud_domain_revision: number;
  };
  source_digests: Record<'reviewed' | 'native_catalog' | 'quota' | 'broker' | 'hud_host' | 'hud_domain', string>;
  current: {
    provider: 'codex';
    model: string | null;
    effort: string | null;
    service_tier: string | null;
    account_correlation: 'unavailable';
    execution_id: null;
    attempt_id: null;
    broker_lease_id: null;
    native: NativeManagerContextInput['current']['native'];
  };
  guidance: {
    reviewed_version: typeof NATIVE_MANAGER_REVIEWED_VERSION;
    task_fit: string[];
    quota_lane_id: 'main';
    remaining_capacity_bands: number[];
    cost_guidance: null;
    economics_status: 'unavailable';
    expected_capability_digest: string;
    models: Array<{ model: string; task_fit: string[]; efforts: string[] }>;
  };
  native_catalog: {
    source: 'codex_app_server_model_list';
    client_version: string;
    capture_id: string;
    capability_digest: string;
    capabilities: Omit<NativeCatalogModel, 'model'> | null;
    models: Array<Pick<NativeCatalogModel, 'model' | 'efforts' | 'service_tiers' | 'hidden'>>;
    drift: string[];
  };
  host_control: Omit<NativeManagerContextInput['host_control'], 'host_revision' | 'domain_revision'>;
  quota: {
    source_revision: SourceRevision;
    generated_at: string;
    observed_at_ms: number;
    lane_id: 'main';
    current_account_key: null;
    routing_available: false;
    eligible_account_keys: string[];
    accounts: RoutingQuotaAccount[];
    delegation_available: boolean;
    grok: GrokAccountView[];
  };
}

interface RoutingQuotaAccount {
  account_key: string;
  account_generation: number;
  provider_generation: number;
  broker_lease_id: null;
  broker_state: null;
  enabled: boolean;
  auth_status: string;
  decision_grade: boolean;
  eligible: boolean;
  exclusions: string[];
  active_lease_count: number;
  lane: null | {
    id: string;
    binding: boolean;
    windows: Array<{
      role: string;
      window_seconds: number | null;
      used_percent: number;
      remaining_percent: number;
      resets_at: string | null;
    }>;
  };
}

export type NativeManagerComposeResult =
  | { ok: true; context: NativeManagerContextSnapshot }
  | { ok: false; error: { code: NativeManagerErrorCode; subject: string | null } };

type NativeManagerErrorCode =
  | 'invalid_input'
  | 'ambiguous_evidence'
  | 'quota_evidence_stale'
  | 'native_catalog_stale';

interface PublicEvidence {
  schema_version: 1 | 2;
  source_revision: SourceRevision;
  provider_source_revisions?: { codex: number; grok: number };
  generated_at: string;
  usage: {
    schema_version: 1;
    generated_at: string;
    claude: null;
    codex: CodexObservation;
    grok: GrokObservation | null;
  };
  account_generations: Array<{ account_key: string; account_generation: number; provider_generation: number }>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validSourceRevision(value: unknown): value is SourceRevision {
  return validRevision(value) || (typeof value === 'string' && SOURCE_REVISION.test(value));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function validPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function fresh(value: number, nowMs: number): boolean {
  return Number.isSafeInteger(value) && value <= nowMs + FUTURE_TOLERANCE_MS && nowMs - value < NATIVE_MANAGER_FRESHNESS_MS;
}

function validStringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(validId) && new Set(value).size === value.length;
}

function validNullableTimestamp(value: unknown): boolean {
  return value === null || validTimestamp(value);
}

function validWindow(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ['role', 'label', 'windowSeconds', 'usedPercent', 'remainingPercent', 'resetsAt', 'resetAfterSeconds', 'limitName', 'meteredFeature'])) return false;
  return ['primary', 'secondary', 'code_review', 'other'].includes(value.role as string) &&
    typeof value.label === 'string' && value.label.length <= 256 &&
    (value.windowSeconds === null || (typeof value.windowSeconds === 'number' && Number.isFinite(value.windowSeconds) && value.windowSeconds >= 0)) &&
    validPercent(value.usedPercent) && validPercent(value.remainingPercent) && validNullableTimestamp(value.resetsAt) &&
    (value.resetAfterSeconds === null || (typeof value.resetAfterSeconds === 'number' && Number.isFinite(value.resetAfterSeconds) && value.resetAfterSeconds >= 0)) &&
    value.limitName === null && value.meteredFeature === null;
}

function validLane(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ['id', 'title', 'binding', 'windows'])) return false;
  return ['main', 'codex-spark', 'code-review'].includes(value.id as string) &&
    ['Main', 'Codex Spark', 'Code Review'].includes(value.title as string) && typeof value.binding === 'boolean' &&
    Array.isArray(value.windows) && value.windows.length <= 16 && value.windows.every(validWindow);
}

function validCodexAccount(value: unknown): value is CodexAccountView {
  if (!record(value) || !exactKeys(value, [
    'accountKey', 'email', 'label', 'ordinal', 'enabled', 'present', 'authStatus', 'reloginRequired', 'identityConflict',
    'manuallyDisabled', 'usageStatus', 'decisionGrade', 'planType', 'limitReached', 'measurementSource', 'measuredAtMs',
    'lanes', 'eligible', 'exclusions', 'headroomPercent', 'activeLeases', 'nextPollAt', 'lastError',
  ], ['resetCreditsAvailable', 'resetCreditExpirations', 'quotaBlockedUntilMs', 'quotaBlockedAtMs'])) return false;
  const times = (candidate: unknown) => candidate === undefined || (record(candidate) && Object.entries(candidate).every(([key, item]) => validId(key) && Number.isSafeInteger(item) && Number(item) >= 0));
  return /^codex-[1-9][0-9]*$/u.test(value.accountKey as string) && value.email === null && value.label === null && value.ordinal === null &&
    typeof value.enabled === 'boolean' && typeof value.present === 'boolean' && ['ok', 'identity-mismatch', 'relogin-required', 'unavailable'].includes(value.authStatus as string) &&
    typeof value.reloginRequired === 'boolean' && typeof value.identityConflict === 'boolean' && typeof value.manuallyDisabled === 'boolean' &&
    ['ok', 'stale', 'unknown', 'error', 'backoff', 'quarantined'].includes(value.usageStatus as string) && typeof value.decisionGrade === 'boolean' &&
    value.planType === null && (value.limitReached === null || typeof value.limitReached === 'boolean') &&
    (value.measurementSource === null || value.measurementSource === 'current' || value.measurementSource === 'last-good') &&
    (value.measuredAtMs === null || (Number.isSafeInteger(value.measuredAtMs) && Number(value.measuredAtMs) >= 0)) &&
    Array.isArray(value.lanes) && value.lanes.length <= 32 && value.lanes.every(validLane) && typeof value.eligible === 'boolean' &&
    validStringArray(value.exclusions, 64) && (value.headroomPercent === null || validPercent(value.headroomPercent)) &&
    Number.isSafeInteger(value.activeLeases) && Number(value.activeLeases) >= 0 && validNullableTimestamp(value.nextPollAt) &&
    (value.lastError === null || (record(value.lastError) && exactKeys(value.lastError, ['code', 'httpStatus', 'summary']) && value.lastError.code === 'usage-unavailable' &&
      (value.lastError.httpStatus === null || (Number.isSafeInteger(value.lastError.httpStatus) && Number(value.lastError.httpStatus) >= 100 && Number(value.lastError.httpStatus) <= 599)) && value.lastError.summary === null)) &&
    times(value.quotaBlockedUntilMs) && times(value.quotaBlockedAtMs);
}

function validCodexObservation(value: unknown): value is CodexObservation {
  if (!record(value) || !exactKeys(value, ['schema_version', 'source_revision', 'observed_at_ms', 'health', 'dependency', 'recommendation', 'accounts', 'notes'])) return false;
  return value.schema_version === 2 && validRevision(value.source_revision) && Number.isSafeInteger(value.observed_at_ms) && Number(value.observed_at_ms) >= 0 &&
    ['ok', 'absent', 'stale', 'malformed', 'unsupported', 'error'].includes(value.health as string) && value.dependency === null &&
    (value.recommendation === null || (record(value.recommendation) && exactKeys(value.recommendation, ['accountKey']) && /^codex-[1-9][0-9]*$/u.test(value.recommendation.accountKey as string))) &&
    Array.isArray(value.accounts) && value.accounts.length <= MAX_ACCOUNTS && value.accounts.every(validCodexAccount) &&
    Array.isArray(value.notes) && value.notes.length === 0;
}

function nullableMoney(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validGrokAccount(value: unknown): value is GrokAccountView {
  if (!record(value) || !exactKeys(value, ['accountKey', 'displayName', 'ordinal', 'alias', 'email', 'enabled', 'authStatus', 'expiresAt', 'billingStatus', 'included', 'prepaid', 'payg', 'subscriptionTier', 'observedAtMs', 'lastGoodAtMs', 'stale', 'error'])) return false;
  const included = value.included;
  const prepaid = value.prepaid;
  const payg = value.payg;
  return /^grok-[1-9][0-9]*$/u.test(value.accountKey as string) && validId(value.displayName) && validRevision(value.ordinal) && value.alias === null && value.email === null &&
    typeof value.enabled === 'boolean' && ['valid', 'expired', 'missing', 'error'].includes(value.authStatus as string) && value.expiresAt === null &&
    ['fresh', 'stale', 'unknown', 'error'].includes(value.billingStatus as string) &&
    (included === null || (record(included) && exactKeys(included, ['usedPercent', 'remainingPercent', 'periodType', 'periodStart', 'resetsAt']) &&
      (included.usedPercent === null || validPercent(included.usedPercent)) && (included.remainingPercent === null || validPercent(included.remainingPercent)) &&
      (included.periodType === null || (typeof included.periodType === 'string' && included.periodType.length <= 256)) && validNullableTimestamp(included.periodStart) && validNullableTimestamp(included.resetsAt))) &&
    (prepaid === null || (record(prepaid) && exactKeys(prepaid, ['balanceUsd']) && nullableMoney(prepaid.balanceUsd))) &&
    (payg === null || (record(payg) && exactKeys(payg, ['enabled', 'usedUsd', 'capUsd', 'remainingUsd']) && (payg.enabled === null || typeof payg.enabled === 'boolean') && nullableMoney(payg.usedUsd) && nullableMoney(payg.capUsd) && nullableMoney(payg.remainingUsd))) &&
    value.subscriptionTier === null && (value.observedAtMs === null || (Number.isSafeInteger(value.observedAtMs) && Number(value.observedAtMs) >= 0)) &&
    (value.lastGoodAtMs === null || (Number.isSafeInteger(value.lastGoodAtMs) && Number(value.lastGoodAtMs) >= 0)) && typeof value.stale === 'boolean' &&
    (value.error === null || (record(value.error) && exactKeys(value.error, ['code', 'message']) && (value.error.code === null || (typeof value.error.code === 'string' && value.error.code.length <= 256)) && value.error.message === 'Grok usage is unavailable'));
}

function validGrokObservation(value: unknown): value is GrokObservation {
  if (!record(value) || !exactKeys(value, ['schema_version', 'source_revision', 'observed_at_ms', 'health', 'dependency', 'accounts', 'notes'])) return false;
  return value.schema_version === 1 && validRevision(value.source_revision) && Number.isSafeInteger(value.observed_at_ms) && Number(value.observed_at_ms) >= 0 &&
    ['ok', 'absent', 'stale', 'malformed', 'unsupported', 'error'].includes(value.health as string) && value.dependency === null &&
    Array.isArray(value.accounts) && value.accounts.length <= MAX_ACCOUNTS && value.accounts.every(validGrokAccount) && Array.isArray(value.notes) && value.notes.length === 0;
}

function parseEvidence(value: unknown): PublicEvidence | null {
  if (!record(value)) return null;
  const v2 = value.schema_version === 2;
  if (!(value.schema_version === 1 || v2) || !exactKeys(value, v2
    ? ['schema_version', 'source_revision', 'provider_source_revisions', 'generated_at', 'usage', 'account_generations']
    : ['schema_version', 'source_revision', 'generated_at', 'usage', 'account_generations'])) return null;
  if (!validSourceRevision(value.source_revision) || (v2 ? typeof value.source_revision !== 'string' : typeof value.source_revision !== 'number') || !validTimestamp(value.generated_at)) return null;
  if (!record(value.usage) || !exactKeys(value.usage, ['schema_version', 'generated_at', 'claude', 'codex', 'grok']) || value.usage.schema_version !== 1 || value.usage.generated_at !== value.generated_at || value.usage.claude !== null || !validCodexObservation(value.usage.codex)) return null;
  if (v2) {
    if (!record(value.provider_source_revisions) || !exactKeys(value.provider_source_revisions, ['codex', 'grok']) || !validRevision(value.provider_source_revisions.codex) || !validRevision(value.provider_source_revisions.grok) || !validGrokObservation(value.usage.grok)) return null;
    if (value.provider_source_revisions.codex !== value.usage.codex.source_revision || value.provider_source_revisions.grok !== value.usage.grok.source_revision) return null;
  } else if (value.usage.grok !== null || value.source_revision !== value.usage.codex.source_revision) return null;
  if (!Array.isArray(value.account_generations) || value.account_generations.length < 1 || value.account_generations.length > MAX_ACCOUNTS) return null;
  for (const generation of value.account_generations) {
    if (!record(generation) || !exactKeys(generation, ['account_key', 'account_generation', 'provider_generation']) || !/^(?:codex|grok)-[1-9][0-9]*$/u.test(generation.account_key as string) || !validRevision(generation.account_generation) || !validRevision(generation.provider_generation)) return null;
  }
  return value as unknown as PublicEvidence;
}

function validNativeModel(value: unknown): value is NativeCatalogModel {
  if (!record(value) || !exactKeys(value, ['model', 'efforts', 'service_tiers', 'hidden', 'default_effort', 'default_service_tier', 'is_default', 'multi_agent_version', 'input_modalities'])) return false;
  return validId(value.model) && validStringArray(value.efforts, 16) && validStringArray(value.service_tiers, 16) && typeof value.hidden === 'boolean' &&
    validId(value.default_effort) && value.efforts.includes(value.default_effort) && (value.default_service_tier === null || (validId(value.default_service_tier) && value.service_tiers.includes(value.default_service_tier))) &&
    typeof value.is_default === 'boolean' && (value.multi_agent_version === null || validId(value.multi_agent_version)) && validStringArray(value.input_modalities, 32);
}

function parseInput(value: unknown): NativeManagerContextInput | null {
  if (!record(value) || !exactKeys(value, ['schema_version', 'producer_generation', 'context_revision', 'trigger', 'composed_at', 'reviewed', 'native_catalog', 'current', 'host_control', 'evidence'])) return null;
  if (value.schema_version !== 1 || !validRevision(value.producer_generation) || !validRevision(value.context_revision) || !['initial', 'heartbeat', 'material_change', 'static_change', 'producer_generation_change'].includes(value.trigger as string) || !validTimestamp(value.composed_at)) return null;
  const reviewed = value.reviewed;
  const catalog = value.native_catalog;
  const current = value.current;
  const host = value.host_control;
  if (!record(reviewed) || !exactKeys(reviewed, ['revision', 'source_version']) || !validRevision(reviewed.revision) || reviewed.source_version !== NATIVE_MANAGER_REVIEWED_VERSION) return null;
  if (!record(catalog) || !exactKeys(catalog, ['revision', 'source', 'client_version', 'capture_id', 'observed_at', 'models']) || !validRevision(catalog.revision) || catalog.source !== 'codex_app_server_model_list' || !validId(catalog.client_version) || !validId(catalog.capture_id) || !validTimestamp(catalog.observed_at) || !Array.isArray(catalog.models) || catalog.models.length > 256 || !catalog.models.every(validNativeModel)) return null;
  if (!record(current) || !exactKeys(current, ['model', 'effort', 'service_tier', 'native']) || !(current.model === null || validId(current.model)) || !(current.effort === null || validId(current.effort)) || !(current.service_tier === null || validId(current.service_tier)) || !record(current.native) || !exactKeys(current.native, ['process_instance_id', 'runtime_build_id', 'session_id']) || !validId(current.native.process_instance_id) || !validId(current.native.runtime_build_id) || !validId(current.native.session_id)) return null;
  if (current.model === null && (current.effort !== null || current.service_tier !== null)) return null;
  if (!record(host) || !exactKeys(host, ['host_revision', 'domain_revision', 'host_id', 'server_id', 'history_namespace', 'host_incarnation', 'domain_id', 'controller_id', 'control_epoch', 'target', 'scope_id', 'allowed_actions']) || !validRevision(host.host_revision) || !validRevision(host.domain_revision) || !validId(host.host_id) || !validId(host.server_id) || !validId(host.history_namespace) || !validId(host.host_incarnation) || !validId(host.domain_id) || !validId(host.controller_id) || !validRevision(host.control_epoch) || !validId(host.scope_id) || !record(host.target) || !exactKeys(host.target, ['kind', 'id']) || host.target.kind !== 'codex_root' || !validId(host.target.id) || !Array.isArray(host.allowed_actions) || host.allowed_actions.length < 1 || host.allowed_actions.length > 3 || new Set(host.allowed_actions).size !== host.allowed_actions.length || !host.allowed_actions.every((item) => ALLOWED_ACTIONS.has(item as string))) return null;
  if (host.target.id !== current.native.session_id || parseEvidence(value.evidence) === null) return null;
  return value as unknown as NativeManagerContextInput;
}

function nativeCatalog(input: NativeManagerContextInput): { models: NativeManagerContextSnapshot['native_catalog']['models']; capabilities: NativeManagerContextSnapshot['native_catalog']['capabilities']; drift: string[] } | null {
  const seen = new Set<string>();
  for (const row of input.native_catalog.models) {
    if (seen.has(row.model)) return null;
    seen.add(row.model);
  }
  const rows = [...input.native_catalog.models].sort((left, right) => left.model.localeCompare(right.model));
  const byModel = new Map(rows.map((row) => [row.model, row]));
  const drift = new Set<string>();
  for (const expected of REVIEWED_MODELS) {
    const row = byModel.get(expected.model);
    if (row === undefined) drift.add(`missing-model:${expected.model}`);
    else {
      if (row.hidden) drift.add(`hidden-model:${expected.model}`);
      if (canonical(sorted(row.efforts)) !== canonical(sorted(expected.efforts))) drift.add(`effort-mismatch:${expected.model}`);
    }
  }
  // Hidden native-only entries remain useful catalog facts, but are not
  // delegation targets and therefore do not invalidate the reviewed role list.
  for (const row of rows) if (!row.hidden && !REVIEWED_MODELS.some((expected) => expected.model === row.model)) drift.add(`unknown-model:${row.model}`);
  const selected = input.current.model === null ? undefined : byModel.get(input.current.model);
  if (input.current.model !== null && selected === undefined) drift.add(`current-model-unknown:${input.current.model}`);
  if (selected !== undefined) {
    if (selected.hidden) drift.add(`current-model-hidden:${selected.model}`);
    if (input.current.effort === null || !selected.efforts.includes(input.current.effort)) drift.add(`current-effort-mismatch:${selected.model}`);
    if (input.current.service_tier !== null && !selected.service_tiers.includes(input.current.service_tier)) drift.add(`current-tier-mismatch:${selected.model}`);
  }
  return {
    models: rows.map(({ model, efforts, service_tiers, hidden }) => ({ model, efforts: sorted(efforts), service_tiers: sorted(service_tiers), hidden })),
    capabilities: selected === undefined ? null : {
      efforts: sorted(selected.efforts), service_tiers: sorted(selected.service_tiers), hidden: selected.hidden,
      default_effort: selected.default_effort, default_service_tier: selected.default_service_tier, is_default: selected.is_default,
      multi_agent_version: selected.multi_agent_version, input_modalities: sorted(selected.input_modalities),
    },
    drift: sorted(drift),
  };
}

function measurementFresh(account: CodexAccountView, nowMs: number): boolean {
  if (account.measurementSource !== 'current' || account.measuredAtMs === null || !fresh(account.measuredAtMs, nowMs)) return false;
  return !account.lanes.some((lane) => lane.windows.some((window) => window.resetsAt !== null && Date.parse(window.resetsAt) <= nowMs && account.measuredAtMs! < Date.parse(window.resetsAt)));
}

function laneAvailable(account: CodexAccountView, lane: CodexLane | undefined, nowMs: number): boolean {
  if (lane === undefined || !lane.binding || lane.windows.length === 0 || lane.windows.some((window) => window.remainingPercent <= 0)) return false;
  const cooldown = account.quotaBlockedUntilMs?.[lane.id];
  return !(cooldown !== undefined && cooldown > nowMs) && account.eligible && account.limitReached !== true;
}

function codexQuotaAccount(account: CodexAccountView, generation: PublicEvidence['account_generations'][number], observationFresh: boolean, nowMs: number): RoutingQuotaAccount | null {
  const lanes = account.lanes.filter((candidate) => candidate.id === 'main');
  if (lanes.length > 1) return null;
  const lane = lanes[0];
  const exclusions = new Set(account.exclusions.filter((entry) => PUBLIC_EXCLUSIONS.has(entry)));
  if (account.exclusions.some((entry) => !PUBLIC_EXCLUSIONS.has(entry))) exclusions.add('other_account_exclusion');
  const measured = measurementFresh(account, nowMs);
  if (!observationFresh) exclusions.add('stale_observation');
  if (!measured) exclusions.add('stale_measurement');
  if (!laneAvailable(account, lane, nowMs)) exclusions.add('quota_lane_unavailable');
  const decisionGrade = observationFresh && account.decisionGrade && measured;
  const eligible = decisionGrade && account.enabled && account.present && account.usageStatus === 'ok' && account.authStatus === 'ok' && !account.reloginRequired && !account.identityConflict && !account.manuallyDisabled && laneAvailable(account, lane, nowMs);
  return {
    account_key: account.accountKey, account_generation: generation.account_generation, provider_generation: generation.provider_generation,
    broker_lease_id: null, broker_state: null, enabled: account.enabled, auth_status: account.authStatus, decision_grade: decisionGrade,
    eligible, exclusions: sorted(exclusions), active_lease_count: account.activeLeases,
    lane: lane === undefined ? null : { id: lane.id, binding: lane.binding, windows: lane.windows.map((window) => ({ role: window.role, window_seconds: window.windowSeconds, used_percent: window.usedPercent, remaining_percent: window.remainingPercent, resets_at: window.resetsAt })) },
  };
}

function grokEligible(account: GrokAccountView, observationFresh: boolean, nowMs: number): boolean {
  return observationFresh && account.enabled && account.authStatus === 'valid' && account.billingStatus === 'fresh' && !account.stale && account.error === null &&
    account.observedAtMs !== null && fresh(account.observedAtMs, nowMs) && account.included !== null &&
    account.included.remainingPercent !== null && account.included.remainingPercent > 0 &&
    account.included.resetsAt !== null && Date.parse(account.included.resetsAt) > nowMs;
}

function fail(code: NativeManagerErrorCode, subject: string | null = null): NativeManagerComposeResult {
  return { ok: false, error: { code, subject } };
}

export function composeNativeManagerRoutingContext(value: unknown, nowMs = Date.now()): NativeManagerComposeResult {
  const input = parseInput(value);
  if (input === null || !Number.isSafeInteger(nowMs) || nowMs < 0) return fail('invalid_input');
  const composedMs = Date.parse(input.composed_at);
  const nativeObservedMs = Date.parse(input.native_catalog.observed_at);
  if (composedMs > nowMs + FUTURE_TOLERANCE_MS || nowMs - composedMs >= NATIVE_MANAGER_FRESHNESS_MS) return fail('invalid_input', 'composed_at');
  if (!fresh(nativeObservedMs, nowMs)) return fail('native_catalog_stale');
  const evidence = parseEvidence(input.evidence)!;
  const generatedMs = Date.parse(evidence.generated_at);
  if (!fresh(generatedMs, nowMs)) return fail('quota_evidence_stale');
  const catalog = nativeCatalog(input);
  if (catalog === null) return fail('invalid_input', 'native_catalog.models');

  const codex = evidence.usage.codex;
  const grok = evidence.usage.grok;
  const codexFresh = codex.health === 'ok' && fresh(codex.observed_at_ms, nowMs);
  const grokFresh = grok !== null && grok.health === 'ok' && fresh(grok.observed_at_ms, nowMs);
  const observedKeys = [...codex.accounts.map((account) => account.accountKey), ...(grok?.accounts.map((account) => account.accountKey) ?? [])];
  if (new Set(observedKeys).size !== observedKeys.length) return fail('ambiguous_evidence', 'account_key');
  const generations = new Map<string, PublicEvidence['account_generations'][number]>();
  for (const generation of evidence.account_generations) {
    if (generations.has(generation.account_key)) return fail('ambiguous_evidence', generation.account_key);
    generations.set(generation.account_key, generation);
  }
  if (generations.size !== observedKeys.length || observedKeys.some((key) => !generations.has(key))) return fail('ambiguous_evidence', 'account_generations');

  const accounts: RoutingQuotaAccount[] = [];
  for (const account of [...codex.accounts].sort((left, right) => left.accountKey.localeCompare(right.accountKey))) {
    const row = codexQuotaAccount(account, generations.get(account.accountKey)!, codexFresh, nowMs);
    if (row === null) return fail('ambiguous_evidence', account.accountKey);
    accounts.push(row);
  }
  const grokAccounts = grok === null ? [] : [...grok.accounts].sort((left, right) => left.accountKey.localeCompare(right.accountKey)).map((account) => structuredClone(account));
  const eligibleKeys = sorted([
    ...accounts.filter((account) => account.eligible).map((account) => account.account_key),
    ...(grok?.accounts.filter((account) => grokEligible(account, grokFresh, nowMs)).map((account) => account.accountKey) ?? []),
  ]);

  const expiryCandidates = [nativeObservedMs + NATIVE_MANAGER_FRESHNESS_MS, generatedMs + NATIVE_MANAGER_FRESHNESS_MS];
  if (codexFresh) expiryCandidates.push(codex.observed_at_ms + NATIVE_MANAGER_FRESHNESS_MS);
  if (grokFresh && grok !== null) expiryCandidates.push(grok.observed_at_ms + NATIVE_MANAGER_FRESHNESS_MS);
  for (const account of codex.accounts) if (accounts.find((row) => row.account_key === account.accountKey)?.eligible && account.measuredAtMs !== null) {
    expiryCandidates.push(account.measuredAtMs + NATIVE_MANAGER_FRESHNESS_MS);
    for (const window of account.lanes.find((lane) => lane.id === 'main')?.windows ?? []) if (window.resetsAt !== null && Date.parse(window.resetsAt) > nowMs) expiryCandidates.push(Date.parse(window.resetsAt));
  }
  for (const account of grok?.accounts ?? []) if (grokEligible(account, grokFresh, nowMs)) {
    expiryCandidates.push(account.observedAtMs! + NATIVE_MANAGER_FRESHNESS_MS, Date.parse(account.included!.resetsAt!));
  }
  const expiresAtMs = Math.min(...expiryCandidates);
  if (expiresAtMs <= composedMs) return fail('quota_evidence_stale');

  const reviewedSource = { version: input.reviewed.source_version, models: REVIEWED_MODELS };
  const brokerSource: [] = [];
  const hudHostSource = {
    revision: input.host_control.host_revision, host_id: input.host_control.host_id, server_id: input.host_control.server_id,
    history_namespace: input.host_control.history_namespace, host_incarnation: input.host_control.host_incarnation,
  };
  const hudDomainSource = {
    revision: input.host_control.domain_revision, domain_id: input.host_control.domain_id, controller_id: input.host_control.controller_id,
    control_epoch: input.host_control.control_epoch, target: input.host_control.target, scope_id: input.host_control.scope_id,
    allowed_actions: input.host_control.allowed_actions,
  };
  const sourceDigests = {
    reviewed: digest(reviewedSource), native_catalog: digest(input.native_catalog),
    quota: digest({ revision: evidence.source_revision, usage: evidence.usage, account_generations: evidence.account_generations }),
    broker: digest(brokerSource), hud_host: digest(hudHostSource), hud_domain: digest(hudDomainSource),
  };
  const guidanceModels = catalog.drift.length === 0
    ? REVIEWED_MODELS.map((model) => ({ model: model.model, task_fit: [...model.task_fit], efforts: [...model.efforts] }))
    : [];
  const currentTaskFit = input.current.model === null ? [] : [...(REVIEWED_MODELS.find((item) => item.model === input.current.model)?.task_fit ?? [])];
  const evidenceBody = {
    sources: {
      reviewed_revision: input.reviewed.revision, native_catalog_revision: input.native_catalog.revision, quota_revision: evidence.source_revision,
      broker_incarnation: 'unavailable' as const, broker_revision_digest: sourceDigests.broker, broker_lease_revisions: [] as [],
      hud_host_revision: input.host_control.host_revision, hud_domain_revision: input.host_control.domain_revision,
    },
    source_digests: sourceDigests,
    current: {
      provider: 'codex' as const, model: input.current.model, effort: input.current.effort, service_tier: input.current.service_tier,
      account_correlation: 'unavailable' as const, execution_id: null, attempt_id: null, broker_lease_id: null,
      native: structuredClone(input.current.native),
    },
    guidance: {
      reviewed_version: NATIVE_MANAGER_REVIEWED_VERSION, task_fit: currentTaskFit, quota_lane_id: 'main' as const,
      remaining_capacity_bands: [...CAPACITY_BANDS], cost_guidance: null, economics_status: 'unavailable' as const,
      expected_capability_digest: digest(reviewedSource), models: guidanceModels,
    },
    native_catalog: {
      source: 'codex_app_server_model_list' as const, client_version: input.native_catalog.client_version, capture_id: input.native_catalog.capture_id,
      capability_digest: digest(catalog.models), capabilities: catalog.capabilities, models: catalog.models, drift: catalog.drift,
    },
    host_control: {
      host_id: input.host_control.host_id, server_id: input.host_control.server_id, history_namespace: input.host_control.history_namespace,
      host_incarnation: input.host_control.host_incarnation, domain_id: input.host_control.domain_id, controller_id: input.host_control.controller_id,
      control_epoch: input.host_control.control_epoch, target: structuredClone(input.host_control.target), scope_id: input.host_control.scope_id,
      allowed_actions: [...input.host_control.allowed_actions],
    },
    quota: {
      source_revision: evidence.source_revision, generated_at: evidence.generated_at,
      observed_at_ms: Math.max(codex.observed_at_ms, grok?.observed_at_ms ?? 0), lane_id: 'main' as const,
      current_account_key: null, routing_available: false as const, eligible_account_keys: eligibleKeys,
      accounts, delegation_available: catalog.drift.length === 0 && eligibleKeys.length > 0, grok: grokAccounts,
    },
  };
  const evidenceDigest = digest(evidenceBody);
  const decisionDigest = digest({
    current: evidenceBody.current, guidance: evidenceBody.guidance, native_catalog: evidenceBody.native_catalog,
    host_control: evidenceBody.host_control,
    quota: { lane_id: 'main', eligible_account_keys: eligibleKeys, delegation_available: evidenceBody.quota.delegation_available, accounts: accounts.map(({ account_key, account_generation, provider_generation, decision_grade, eligible, exclusions, lane }) => ({ account_key, account_generation, provider_generation, decision_grade, eligible, exclusions, lane })), grok: grokAccounts.map((account) => ({ accountKey: account.accountKey, eligible: eligibleKeys.includes(account.accountKey) })) },
  });
  const context: NativeManagerContextSnapshot = {
    schema_version: 2, producer_generation: input.producer_generation, context_revision: input.context_revision, digest: '',
    evidence_digest: evidenceDigest, decision_digest: decisionDigest, trigger: input.trigger, composed_at: input.composed_at,
    observed_at: new Date(evidenceBody.quota.observed_at_ms).toISOString(), expires_at: new Date(expiresAtMs).toISOString(), ...evidenceBody,
  };
  context.digest = digest(context);
  if (!HEX.test(context.digest)) return fail('invalid_input');
  return { ok: true, context };
}

/** JSON-only seam suitable for a one-shot CLI wrapper; it performs no I/O. */
export function composeNativeManagerRoutingContextJson(raw: string, nowMs = Date.now()): string {
  try {
    return JSON.stringify(composeNativeManagerRoutingContext(JSON.parse(raw), nowMs));
  } catch {
    return JSON.stringify(fail('invalid_input'));
  }
}
