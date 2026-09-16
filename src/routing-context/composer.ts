import { createHash } from 'node:crypto';
import { validateCatalogAuditInput } from '../catalog/validate.ts';
import type { CapabilitySet, CatalogAuditInput } from '../catalog/types.ts';
import type { CodexAccountView, CodexLane, CodexObservation } from '../codex/types.ts';
import type { FxBrokerBindingReceipt } from '../fx-broker/types.ts';
import {
  ROUTING_CONTEXT_FRESHNESS_MS,
  ROUTING_CONTEXT_SCHEMA_VERSION,
  type ReviewedRoutingModel,
  type RoutingContextComposeResult,
  type RoutingContextConsumptionReceipt,
  type RoutingContextDelivery,
  type RoutingContextErrorCode,
  type RoutingContextInput,
  type RoutingContextQuotaAccount,
  type RoutingContextSnapshot,
} from './types.ts';

const FUTURE_TOLERANCE_MS = 5_000;
const MAX_INPUT_ITEMS = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/u;
const PUBLIC_EXCLUSIONS = new Set([
  'manually_disabled',
  'quota_exhausted',
  'relogin_required',
  'usage_unknown',
]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeCapabilities(capability: CapabilitySet): CapabilitySet {
  return {
    ...capability,
    efforts: sorted(capability.efforts),
    service_tiers: sorted(capability.service_tiers),
    input_modalities: sorted(capability.input_modalities),
  };
}

export function routingCapabilityDigest(capability: CapabilitySet): string {
  return digest(normalizeCapabilities(capability));
}

function nativeCapability(row: Record<string, unknown>): CapabilitySet {
  const tiers = row.serviceTiers as Array<Record<string, unknown>> | undefined;
  return normalizeCapabilities({
    hidden: row.hidden as boolean,
    efforts: (row.supportedReasoningEfforts as Array<Record<string, unknown>>).map((item) => item.reasoningEffort as string),
    default_effort: row.defaultReasoningEffort as string,
    service_tiers: tiers === undefined ? (row.additionalSpeedTiers as string[] | undefined) ?? [] : tiers.map((item) => item.id as string),
    default_service_tier: row.defaultServiceTier as string | null,
    is_default: row.isDefault as boolean,
    multi_agent_version: row.multiAgentVersion as string | null,
    input_modalities: row.inputModalities as string[],
  });
}

function fail(code: RoutingContextErrorCode, subject: string | null = null): RoutingContextComposeResult {
  return { ok: false, error: { code, subject } };
}

function snapshotDigestValid(snapshot: RoutingContextSnapshot): boolean {
  return /^[a-f0-9]{64}$/u.test(snapshot.digest) && digest({ ...snapshot, digest: '' }) === snapshot.digest;
}

function deliveryDigest(
  producerGeneration: number,
  contextRevision: number,
  contextDigest: string,
  payload: unknown,
): string {
  return digest({
    producer_generation: producerGeneration,
    context_revision: contextRevision,
    context_digest: contextDigest,
    payload,
  });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function fresh(time: number, nowMs: number): boolean {
  return time <= nowMs + FUTURE_TOLERANCE_MS && nowMs - time < ROUTING_CONTEXT_FRESHNESS_MS;
}

function inputShapeValid(input: RoutingContextInput): boolean {
  const current = input.current;
  const host = input.hud?.host;
  const domain = input.hud?.domain;
  return input.schema_version === 1 && input.hud?.schema_version === 1 &&
    validRevision(input.producer_generation) && current?.provider === 'codex' && validId(current.model) && validId(current.effort) &&
    (current.service_tier === null || validId(current.service_tier)) && validId(current.broker_lease_id) &&
    validId(current.execution_id) && validId(current.attempt_id) && validId(current.native?.process_instance_id) &&
    validId(current.native?.fx_build_revision) && validId(current.native?.session_id) &&
    input.reviewed?.schema_version === 1 && validRevision(input.reviewed.revision) &&
    validRevision(input.native_catalog?.revision) && validRevision(input.quota?.revision) &&
    Array.isArray(input.quota?.account_generations) && input.quota.account_generations.length > 0 &&
    input.quota.account_generations.length <= MAX_INPUT_ITEMS &&
    Array.isArray(input.reviewed.guidance) && input.reviewed.guidance.length <= MAX_INPUT_ITEMS &&
    Array.isArray(input.broker_receipts) && input.broker_receipts.length > 0 && input.broker_receipts.length <= MAX_INPUT_ITEMS &&
    host?.kind === 'host' && validId(host.id) && validRevision(host.revision) && validId(host.owner) && validId(host.serverId) &&
    validId(host.historyNamespace) && validId(host.incarnation) && typeof host.active === 'boolean' &&
    domain?.kind === 'domain' && validId(domain.id) && validRevision(domain.revision) && validId(domain.hostId) &&
    domain.target?.kind === 'fx_session' && validId(domain.target.id) && validId(domain.controllerId) &&
    validRevision(domain.controlEpoch) && validId(domain.scopeId) && typeof domain.active === 'boolean' &&
    Array.isArray(domain.allowedActions) && domain.allowedActions.length > 0 &&
    new Set(domain.allowedActions).size === domain.allowedActions.length &&
    domain.allowedActions.every((action) => action === 'start' || action === 'steer' || action === 'interrupt');
}

function validateGuidance(input: RoutingContextInput): ReviewedRoutingModel | null {
  const seen = new Set<string>();
  let selected: ReviewedRoutingModel | null = null;
  for (const item of input.reviewed.guidance) {
    if (item.provider !== 'codex' || !validId(item.model_id) || !validId(item.quota_lane_id) || !Array.isArray(item.task_fit) ||
      item.task_fit.length === 0 || item.task_fit.length > 64 || item.task_fit.some((value) => !validId(value)) ||
      !Array.isArray(item.remaining_capacity_bands) || item.remaining_capacity_bands.length === 0 || item.remaining_capacity_bands.length > 32 ||
      item.remaining_capacity_bands.some((value) => !Number.isFinite(value) || value < 0 || value > 100) ||
      new Set(item.remaining_capacity_bands).size !== item.remaining_capacity_bands.length ||
      item.remaining_capacity_bands.some((value, index) => index > 0 && value <= item.remaining_capacity_bands[index - 1]!) ||
      item.cost_guidance?.comparison_scope !== 'within_provider' || !validId(item.cost_guidance.basis) ||
      !validId(item.cost_guidance.unit) || !Number.isFinite(item.cost_guidance.relative_units) || item.cost_guidance.relative_units <= 0) return null;
    const key = `${item.provider}\0${item.model_id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (item.model_id === input.current.model) selected = item;
  }
  return selected;
}

function receiptValid(receipt: FxBrokerBindingReceipt): boolean {
  return receipt.schema_version === 1 && validId(receipt.lease_id) && validId(receipt.binding_id) &&
    /^[a-f0-9]{64}$/u.test(receipt.binding_digest) && /^[a-f0-9]{64}$/u.test(receipt.authority_digest) &&
    validId(receipt.broker_incarnation) && validRevision(receipt.lease_revision) && validId(receipt.owner?.host_id) &&
    validId(receipt.owner?.host_incarnation) && validRevision(receipt.owner?.control_epoch) && validId(receipt.owner?.execution_id) &&
    validId(receipt.owner?.attempt_id) && receipt.account?.provider === 'codex' && /^codex-[1-9]\d*$/u.test(receipt.account.account_key) &&
    validRevision(receipt.account.account_generation) && validRevision(receipt.account.provider_generation) &&
    receipt.target?.provider === 'codex' && receipt.target.protocol === 'openai-responses' && validId(receipt.target.target_id) &&
    validId(receipt.target.target_revision) && validId(receipt.target.model) &&
    validId(receipt.target.effort) && (receipt.target.service_tier === null || validId(receipt.target.service_tier)) &&
    validId(receipt.target.capability_capture_id) && /^[a-f0-9]{64}$/u.test(receipt.target.capability_digest) &&
    Number.isSafeInteger(receipt.issued_at_ms) && Number.isSafeInteger(receipt.activate_before_ms) &&
    Number.isSafeInteger(receipt.expires_at_ms) && Number.isSafeInteger(receipt.execution_deadline_ms) &&
    receipt.issued_at_ms <= receipt.activate_before_ms && receipt.activate_before_ms <= receipt.expires_at_ms &&
    receipt.expires_at_ms <= receipt.execution_deadline_ms && typeof receipt.activation_supported === 'boolean' &&
    ['prepared', 'active', 'expired', 'revoked', 'released'].includes(receipt.state);
}

function matchingReceipt(
  receipt: FxBrokerBindingReceipt,
  input: RoutingContextInput,
  captureId: string,
  capabilityDigest: string,
  nowMs: number,
): boolean {
  const owner = receipt.owner;
  const target = receipt.target;
  return receiptValid(receipt) && (receipt.state === 'prepared' || receipt.state === 'active') &&
    receipt.expires_at_ms > nowMs && receipt.execution_deadline_ms > nowMs &&
    (receipt.state === 'active' || receipt.activate_before_ms > nowMs) && receipt.activation_supported &&
    owner.host_id === input.hud.host.id && owner.host_incarnation === input.hud.host.incarnation &&
    owner.control_epoch === input.hud.domain.controlEpoch && owner.execution_id === input.current.execution_id &&
    target.provider === input.current.provider && target.model === input.current.model && target.effort === input.current.effort &&
    target.service_tier === input.current.service_tier && target.capability_capture_id === captureId &&
    target.capability_digest === capabilityDigest;
}

function accountMeasurementFresh(account: CodexAccountView, nowMs: number): boolean {
  return account.measurementSource === 'current' && account.measuredAtMs !== null && fresh(account.measuredAtMs, nowMs) &&
    !account.lanes.some((lane) => lane.windows.some((window) => window.resetsAt !== null &&
      Date.parse(window.resetsAt) <= nowMs && account.measuredAtMs! < Date.parse(window.resetsAt)));
}

function laneAvailable(account: CodexAccountView, lane: CodexLane | undefined, nowMs: number): boolean {
  if (lane === undefined || lane.windows.length === 0 || lane.windows.some((window) => window.remainingPercent <= 0)) return false;
  const cooldown = account.quotaBlockedUntilMs?.[lane.id];
  if (cooldown !== undefined && cooldown > nowMs) return false;
  return lane.id !== 'main' || (account.eligible && account.limitReached !== true);
}

function capacityBand(account: RoutingContextQuotaAccount, bands: number[]): number | null {
  if (account.lane === null || account.lane.windows.length === 0) return null;
  const remaining = Math.min(...account.lane.windows.map((window) => window.remaining_percent));
  let band = bands[0]!;
  for (const threshold of bands) {
    if (remaining < threshold) break;
    band = threshold;
  }
  return band;
}

function quotaAccount(
  account: CodexAccountView,
  laneId: string,
  receipt: FxBrokerBindingReceipt | null,
  generation: { account_generation: number; provider_generation: number },
  observation: CodexObservation,
  nowMs: number,
): RoutingContextQuotaAccount {
  const lane = account.lanes.find((candidate) => candidate.id === laneId);
  const exclusions = new Set(account.exclusions.filter((entry) => PUBLIC_EXCLUSIONS.has(entry)));
  if (account.exclusions.some((entry) => !PUBLIC_EXCLUSIONS.has(entry))) exclusions.add('other_account_exclusion');
  const measurementFresh = accountMeasurementFresh(account, nowMs);
  if (!measurementFresh) exclusions.add('stale_measurement');
  if (receipt === null) exclusions.add('broker_receipt_missing');
  if (!laneAvailable(account, lane, nowMs)) exclusions.add('quota_lane_unavailable');
  const decisionGrade = observation.health === 'ok' && account.decisionGrade && measurementFresh;
  const eligible = receipt !== null && decisionGrade && account.enabled && account.present && account.usageStatus === 'ok' && account.authStatus === 'ok' &&
    !account.reloginRequired && !account.identityConflict && !account.manuallyDisabled && laneAvailable(account, lane, nowMs);
  return {
    account_key: account.accountKey,
    account_generation: generation.account_generation,
    provider_generation: generation.provider_generation,
    broker_lease_id: receipt?.lease_id ?? null,
    broker_state: receipt?.state ?? null,
    enabled: account.enabled,
    auth_status: account.authStatus === 'ok' ? 'ok' : account.identityConflict ? 'identity_mismatch' : 'unavailable',
    decision_grade: decisionGrade,
    eligible,
    exclusions: sorted([...exclusions]),
    active_lease_count: account.activeLeases,
    lane: lane === undefined ? null : {
      id: lane.id,
      binding: lane.binding,
      windows: lane.windows.map((window) => ({
        role: window.role,
        window_seconds: window.windowSeconds,
        used_percent: window.usedPercent,
        remaining_percent: window.remainingPercent,
        resets_at: window.resetsAt,
      })),
    },
  };
}

function staticSourceChanged(previous: RoutingContextSnapshot, next: RoutingContextSnapshot): boolean {
  return previous.sources.reviewed_revision !== next.sources.reviewed_revision ||
    previous.sources.native_catalog_revision !== next.sources.native_catalog_revision ||
    previous.source_digests.reviewed !== next.source_digests.reviewed ||
    previous.source_digests.native_catalog !== next.source_digests.native_catalog ||
    previous.source_digests.broker !== next.source_digests.broker ||
    previous.source_digests.hud_host !== next.source_digests.hud_host ||
    previous.source_digests.hud_domain !== next.source_digests.hud_domain ||
    digest(previous.current) !== digest(next.current);
}

function sourceRevisionProblem(previous: RoutingContextSnapshot, next: RoutingContextSnapshot): RoutingContextErrorCode | null {
  const pairs = [
    [previous.sources.reviewed_revision, next.sources.reviewed_revision, previous.source_digests.reviewed, next.source_digests.reviewed],
    [previous.sources.native_catalog_revision, next.sources.native_catalog_revision, previous.source_digests.native_catalog, next.source_digests.native_catalog],
    [previous.sources.quota_revision, next.sources.quota_revision, previous.source_digests.quota, next.source_digests.quota],
  ] as const;
  for (const [oldRevision, newRevision, oldDigest, newDigest] of pairs) {
    if (newRevision < oldRevision) return 'source_revision_regressed';
    if (newRevision === oldRevision && oldDigest !== newDigest) return 'source_revision_conflict';
  }
  if (next.sources.hud_host_revision < previous.sources.hud_host_revision ||
    next.sources.hud_domain_revision < previous.sources.hud_domain_revision) return 'source_revision_regressed';
  if (next.sources.hud_host_revision === previous.sources.hud_host_revision &&
    next.source_digests.hud_host !== previous.source_digests.hud_host) return 'source_revision_conflict';
  if (next.sources.hud_domain_revision === previous.sources.hud_domain_revision &&
    next.source_digests.hud_domain !== previous.source_digests.hud_domain) return 'source_revision_conflict';
  const oldBroker = new Map(previous.sources.broker_lease_revisions.map((entry) => [entry.lease_id, entry]));
  for (const entry of next.sources.broker_lease_revisions) {
    const old = oldBroker.get(entry.lease_id);
    if (old !== undefined && entry.lease_revision < old.lease_revision) return 'source_revision_regressed';
    if (old !== undefined && entry.lease_revision === old.lease_revision && entry.receipt_digest !== old.receipt_digest) {
      return 'source_revision_conflict';
    }
  }
  return null;
}

export function composeRoutingContext(
  input: RoutingContextInput,
  previous: RoutingContextSnapshot | null,
  nowMs: number,
): RoutingContextComposeResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !inputShapeValid(input)) return fail('invalid_input');
  if (input.current.provider !== 'codex') return fail('unsupported_provider', input.current.provider);
  let catalog: CatalogAuditInput;
  try {
    catalog = validateCatalogAuditInput({
      schema_version: 1,
      metadata: input.reviewed.catalog,
      native_catalog: input.native_catalog.catalog,
      usage: input.quota.usage,
    });
  } catch {
    return fail('invalid_input');
  }
  if (Date.parse(catalog.metadata.reviewed_at) > nowMs + FUTURE_TOLERANCE_MS || Date.parse(catalog.metadata.review_after) <= nowMs) {
    return fail('reviewed_metadata_stale');
  }
  const capture = catalog.native_catalog.capture_receipt;
  const nativeObservedMs = Date.parse(catalog.native_catalog.observed_at);
  if (capture === undefined || !fresh(nativeObservedMs, nowMs)) return fail('native_catalog_stale');
  const usage = catalog.usage;
  const observation = usage?.codex as CodexObservation | null;
  if (usage === null || observation === null || observation.health !== 'ok' ||
    !fresh(Date.parse(usage.generated_at as string), nowMs) || !fresh(observation.observed_at_ms, nowMs)) return fail('quota_evidence_stale');
  if (observation.accounts.some((account) => typeof account.present !== 'boolean' || typeof account.enabled !== 'boolean' ||
    typeof account.reloginRequired !== 'boolean' || typeof account.identityConflict !== 'boolean' ||
    typeof account.manuallyDisabled !== 'boolean' || typeof account.decisionGrade !== 'boolean' ||
    typeof account.eligible !== 'boolean' || (account.limitReached !== null && typeof account.limitReached !== 'boolean'))) {
    return fail('invalid_input');
  }
  const guidance = validateGuidance(input);
  if (guidance === null) return fail('model_join_mismatch', input.current.model);
  const authored = catalog.metadata.models.find((entry) => entry.model_id === input.current.model);
  const rows = catalog.native_catalog.pages.flatMap((page) => page.data).filter((row) => row.model === input.current.model);
  if (authored === undefined || rows.length !== 1) return fail('ambiguous_join', input.current.model);
  const capabilities = nativeCapability(rows[0]!);
  const expectedDigest = routingCapabilityDigest(authored.expected);
  const capabilityDigest = routingCapabilityDigest(capabilities);
  if (expectedDigest !== capabilityDigest || !capabilities.efforts.includes(input.current.effort) ||
    (input.current.service_tier !== null && !capabilities.service_tiers.includes(input.current.service_tier))) {
    return fail('capability_join_mismatch', input.current.model);
  }
  if (!input.hud.host.active || !input.hud.domain.active || input.hud.domain.hostId !== input.hud.host.id ||
    input.hud.domain.target.id !== input.current.native.session_id) return fail('host_control_join_mismatch');
  if (input.broker_receipts.some((receipt) => !receiptValid(receipt))) return fail('invalid_input');
  const brokerIncarnations = new Set(input.broker_receipts.map((receipt) => receipt.broker_incarnation));
  if (brokerIncarnations.size !== 1) return fail('ambiguous_join', 'broker_incarnation');
  const rawCurrentReceipts = input.broker_receipts.filter((receipt) => receipt.lease_id === input.current.broker_lease_id);
  if (rawCurrentReceipts.length !== 1) return fail('ambiguous_join', input.current.broker_lease_id);
  if (rawCurrentReceipts[0]!.state !== 'active' || rawCurrentReceipts[0]!.expires_at_ms <= nowMs ||
    rawCurrentReceipts[0]!.execution_deadline_ms <= nowMs) return fail('broker_receipt_stale', input.current.broker_lease_id);
  for (const receipt of input.broker_receipts) {
    if ((receipt.state !== 'prepared' && receipt.state !== 'active') || receipt.expires_at_ms <= nowMs ||
      receipt.execution_deadline_ms <= nowMs || (receipt.state === 'prepared' && receipt.activate_before_ms <= nowMs)) {
      return fail('broker_receipt_stale', receipt.lease_id);
    }
    if (receipt.owner.host_id !== input.hud.host.id || receipt.owner.host_incarnation !== input.hud.host.incarnation ||
      receipt.owner.control_epoch !== input.hud.domain.controlEpoch) return fail('host_control_join_mismatch', receipt.lease_id);
    if (receipt.owner.execution_id !== input.current.execution_id) return fail('account_join_mismatch', receipt.lease_id);
    if (receipt.target.provider !== input.current.provider || receipt.target.model !== input.current.model ||
      receipt.target.effort !== input.current.effort || receipt.target.service_tier !== input.current.service_tier ||
      receipt.target.capability_capture_id !== capture.capture_id || receipt.target.capability_digest !== capabilityDigest) {
      return fail('capability_join_mismatch', receipt.lease_id);
    }
    if (!matchingReceipt(receipt, input, capture.capture_id, capabilityDigest, nowMs)) return fail('account_join_mismatch', receipt.lease_id);
  }
  const usableReceipts = input.broker_receipts;
  const receiptAccounts = new Set<string>();
  const receiptLeases = new Set<string>();
  for (const receipt of usableReceipts) {
    if (receiptAccounts.has(receipt.account.account_key) || receiptLeases.has(receipt.lease_id)) return fail('ambiguous_join', receipt.account.account_key);
    receiptAccounts.add(receipt.account.account_key);
    receiptLeases.add(receipt.lease_id);
  }
  const currentReceipt = usableReceipts.find((receipt) => receipt.lease_id === input.current.broker_lease_id);
  if (currentReceipt === undefined || currentReceipt.state !== 'active' || currentReceipt.owner.attempt_id !== input.current.attempt_id ||
    currentReceipt.native === null || currentReceipt.native.process_instance_id !== input.current.native.process_instance_id ||
    currentReceipt.native.fx_build_revision !== input.current.native.fx_build_revision || currentReceipt.native.session_id !== input.current.native.session_id) {
    return fail('account_join_mismatch', input.current.broker_lease_id);
  }
  for (const receipt of usableReceipts) {
    if (receipt.lease_id !== currentReceipt.lease_id && (receipt.state !== 'prepared' || receipt.native !== null)) {
      return fail('ambiguous_join', receipt.lease_id);
    }
  }
  const accounts = [...observation.accounts].sort((left, right) => left.accountKey.localeCompare(right.accountKey));
  const accountKeys = new Set(accounts.map((account) => account.accountKey));
  const generationByAccount = new Map<string, { account_generation: number; provider_generation: number }>();
  for (const item of input.quota.account_generations) {
    if (!/^codex-[1-9]\d*$/u.test(item.account_key) || !validRevision(item.account_generation) ||
      !validRevision(item.provider_generation) || generationByAccount.has(item.account_key)) return fail('invalid_input');
    generationByAccount.set(item.account_key, {
      account_generation: item.account_generation,
      provider_generation: item.provider_generation,
    });
  }
  if (accountKeys.size !== accounts.length || !accountKeys.has(currentReceipt.account.account_key) ||
    generationByAccount.size !== accountKeys.size || [...accountKeys].some((key) => !generationByAccount.has(key)) ||
    usableReceipts.some((receipt) => {
      const generation = generationByAccount.get(receipt.account.account_key);
      return !accountKeys.has(receipt.account.account_key) || generation === undefined ||
        generation.account_generation !== receipt.account.account_generation ||
        generation.provider_generation !== receipt.account.provider_generation;
    })) return fail('account_join_mismatch');
  const currentAccount = accounts.find((account) => account.accountKey === currentReceipt.account.account_key)!;
  if (!accountMeasurementFresh(currentAccount, nowMs)) return fail('quota_evidence_stale', currentAccount.accountKey);
  const byAccount = new Map(usableReceipts.map((receipt) => [receipt.account.account_key, receipt]));
  const quotaAccounts = accounts.map((account) => quotaAccount(
    account,
    guidance.quota_lane_id,
    byAccount.get(account.accountKey) ?? null,
    generationByAccount.get(account.accountKey)!,
    observation,
    nowMs,
  ));
  const observedAtMs = observation.observed_at_ms;
  const accountByKey = new Map(accounts.map((account) => [account.accountKey, account]));
  const decisionBoundaryMs: number[] = [];
  for (const receipt of usableReceipts) {
    if (receipt.state === 'prepared') decisionBoundaryMs.push(receipt.activate_before_ms);
    const account = accountByKey.get(receipt.account.account_key)!;
    if (accountMeasurementFresh(account, nowMs)) {
      decisionBoundaryMs.push(account.measuredAtMs! + ROUTING_CONTEXT_FRESHNESS_MS);
      const lane = account.lanes.find((candidate) => candidate.id === guidance.quota_lane_id);
      for (const window of lane?.windows ?? []) {
        if (window.resetsAt !== null && Date.parse(window.resetsAt) > nowMs) decisionBoundaryMs.push(Date.parse(window.resetsAt));
      }
    }
    const cooldown = account.quotaBlockedUntilMs?.[guidance.quota_lane_id];
    if (cooldown !== undefined && cooldown > nowMs) decisionBoundaryMs.push(cooldown);
  }
  const expiresAtMs = Math.min(
    Date.parse(catalog.metadata.review_after),
    nativeObservedMs + ROUTING_CONTEXT_FRESHNESS_MS,
    Date.parse(usage.generated_at as string) + ROUTING_CONTEXT_FRESHNESS_MS,
    observedAtMs + ROUTING_CONTEXT_FRESHNESS_MS,
    currentAccount.measuredAtMs! + ROUTING_CONTEXT_FRESHNESS_MS,
    ...usableReceipts.flatMap((receipt) => [receipt.expires_at_ms, receipt.execution_deadline_ms]),
    ...decisionBoundaryMs,
  );
  if (expiresAtMs <= nowMs) return fail('broker_receipt_stale', currentReceipt.lease_id);

  const sourceDigests = {
    reviewed: digest(input.reviewed),
    native_catalog: digest(input.native_catalog.catalog),
    quota: digest(input.quota),
    broker: digest(usableReceipts.map((receipt) => structuredClone(receipt)).sort((left, right) => left.lease_id.localeCompare(right.lease_id))),
    hud_host: digest(input.hud.host),
    hud_domain: digest(input.hud.domain),
  };
  const evidence = {
    sources: {
      reviewed_revision: input.reviewed.revision,
      native_catalog_revision: input.native_catalog.revision,
      quota_revision: input.quota.revision,
      broker_incarnation: currentReceipt.broker_incarnation,
      broker_revision_digest: sourceDigests.broker,
      broker_lease_revisions: usableReceipts.map((receipt) => ({
        lease_id: receipt.lease_id,
        lease_revision: receipt.lease_revision,
        receipt_digest: digest(receipt),
      })).sort((left, right) => left.lease_id.localeCompare(right.lease_id)),
      hud_host_revision: input.hud.host.revision,
      hud_domain_revision: input.hud.domain.revision,
    },
    source_digests: sourceDigests,
    current: {
      provider: input.current.provider,
      model: input.current.model,
      effort: input.current.effort,
      service_tier: input.current.service_tier,
      execution_id: input.current.execution_id,
      attempt_id: input.current.attempt_id,
      broker_lease_id: input.current.broker_lease_id,
      native: structuredClone(input.current.native),
    },
    guidance: {
      reviewed_version: catalog.metadata.version,
      task_fit: sorted(guidance.task_fit),
      quota_lane_id: guidance.quota_lane_id,
      remaining_capacity_bands: [...guidance.remaining_capacity_bands],
      cost_guidance: structuredClone(guidance.cost_guidance),
      expected_capability_digest: expectedDigest,
    },
    native_catalog: {
      source: 'codex_app_server_model_list' as const,
      client_version: catalog.native_catalog.client_version,
      capture_id: capture.capture_id,
      capability_digest: capabilityDigest,
      capabilities,
    },
    host_control: {
      host_id: input.hud.host.id,
      server_id: input.hud.host.serverId,
      history_namespace: input.hud.host.historyNamespace,
      host_incarnation: input.hud.host.incarnation,
      domain_id: input.hud.domain.id,
      controller_id: input.hud.domain.controllerId,
      control_epoch: input.hud.domain.controlEpoch,
      target: structuredClone(input.hud.domain.target),
      scope_id: input.hud.domain.scopeId,
      allowed_actions: [...input.hud.domain.allowedActions],
    },
    quota: {
      source_revision: input.quota.revision,
      generated_at: usage.generated_at as string,
      observed_at_ms: observedAtMs,
      lane_id: guidance.quota_lane_id,
      current_account_key: currentReceipt.account.account_key,
      routing_available: quotaAccounts.some((account) => account.eligible),
      eligible_account_keys: quotaAccounts.filter((account) => account.eligible).map((account) => account.account_key),
      accounts: quotaAccounts,
    },
  };
  const evidenceDigest = digest(evidence);
  const decisionDigest = digest({
    current: evidence.current,
    guidance: evidence.guidance,
    native_catalog: evidence.native_catalog,
    host_control: evidence.host_control,
    quota: {
      lane_id: evidence.quota.lane_id,
      current_account_key: evidence.quota.current_account_key,
      routing_available: evidence.quota.routing_available,
      accounts: evidence.quota.accounts.map((account) => ({
        account_key: account.account_key,
        account_generation: account.account_generation,
        provider_generation: account.provider_generation,
        eligible: account.eligible,
        auth_status: account.auth_status,
        exclusions: account.exclusions,
        active_lease_count: account.active_lease_count,
        capacity_band: capacityBand(account, guidance.remaining_capacity_bands),
        reset_windows: account.lane?.windows.map((window) => ({ role: window.role, window_seconds: window.window_seconds, resets_at: window.resets_at })) ?? [],
      })),
    },
  });
  const base = {
    schema_version: ROUTING_CONTEXT_SCHEMA_VERSION,
    producer_generation: input.producer_generation,
    context_revision: previous === null || previous.producer_generation !== input.producer_generation ? 1 : previous.context_revision + 1,
    digest: '',
    evidence_digest: evidenceDigest,
    decision_digest: decisionDigest,
    trigger: 'initial' as RoutingContextSnapshot['trigger'],
    composed_at: new Date(nowMs).toISOString(),
    observed_at: new Date(observedAtMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    ...evidence,
  };
  if (previous !== null) {
    if (!validRevision(previous.context_revision) || !snapshotDigestValid(previous)) return fail('context_revision_conflict');
    if (input.producer_generation < previous.producer_generation) return fail('source_revision_regressed', 'producer_generation');
    if (previous.producer_generation === input.producer_generation) {
      const problem = sourceRevisionProblem(previous, base as RoutingContextSnapshot);
      if (problem !== null) return fail(problem);
      if (previous.evidence_digest === evidenceDigest) return { ok: true, action: 'coalesced', snapshot: previous };
    }
    base.trigger = previous.producer_generation !== input.producer_generation
      ? 'producer_generation_change'
      : staticSourceChanged(previous, base as RoutingContextSnapshot)
        ? 'static_change'
        : previous.decision_digest !== decisionDigest
          ? 'material_change'
          : 'heartbeat';
  }
  const snapshot = base as RoutingContextSnapshot;
  snapshot.digest = digest({ ...snapshot, digest: '' });
  return { ok: true, action: 'published', snapshot };
}

export function coalesceRoutingContext(
  pending: RoutingContextSnapshot | null,
  incoming: RoutingContextSnapshot,
): RoutingContextSnapshot {
  if (!snapshotDigestValid(incoming) || (pending !== null && !snapshotDigestValid(pending))) throw new Error('context_revision_conflict');
  if (pending === null) return incoming;
  if (incoming.producer_generation < pending.producer_generation) return pending;
  if (incoming.producer_generation > pending.producer_generation) return incoming;
  if (incoming.context_revision < pending.context_revision) return pending;
  if (incoming.context_revision === pending.context_revision) {
    if (incoming.digest !== pending.digest) throw new Error('context_revision_conflict');
    return pending;
  }
  return incoming;
}

export function planRoutingContextDelivery(
  consumed: RoutingContextSnapshot | null,
  latest: RoutingContextSnapshot,
): RoutingContextDelivery {
  if (!snapshotDigestValid(latest) || (consumed !== null && !snapshotDigestValid(consumed))) throw new Error('context_revision_conflict');
  if (consumed !== null && consumed.context_revision === latest.context_revision && consumed.digest === latest.digest) {
    return { schema_version: 1, mode: 'none', producer_generation: latest.producer_generation, context_revision: latest.context_revision, digest: latest.digest, delivery_digest: null, reason: 'already_current', payload: null };
  }
  let reason: Extract<RoutingContextDelivery, { mode: 'full' }>['reason'] | null = null;
  if (consumed === null) reason = 'initial';
  else if (latest.producer_generation < consumed.producer_generation) throw new Error('context_revision_conflict');
  else if (consumed.producer_generation !== latest.producer_generation) reason = 'producer_generation_change';
  else if (latest.context_revision <= consumed.context_revision) throw new Error('context_revision_conflict');
  else if (latest.context_revision !== consumed.context_revision + 1) reason = 'revision_gap';
  else if (staticSourceChanged(consumed, latest)) reason = 'static_change';
  if (reason !== null) {
    const payload = structuredClone(latest);
    return {
      schema_version: 1,
      mode: 'full',
      producer_generation: latest.producer_generation,
      context_revision: latest.context_revision,
      digest: latest.digest,
      delivery_digest: deliveryDigest(latest.producer_generation, latest.context_revision, latest.digest, payload),
      reason,
      payload,
    };
  }
  const payload = {
    from_revision: consumed!.context_revision,
    to_revision: latest.context_revision,
    trigger: latest.trigger,
    composed_at: latest.composed_at,
    observed_at: latest.observed_at,
    expires_at: latest.expires_at,
    quota: structuredClone(latest.quota),
    broker_revision_digest: latest.sources.broker_revision_digest,
  };
  return {
    schema_version: 1,
    mode: 'delta',
    producer_generation: latest.producer_generation,
    context_revision: latest.context_revision,
    digest: latest.digest,
    delivery_digest: deliveryDigest(latest.producer_generation, latest.context_revision, latest.digest, payload),
    reason: 'sequential_mutable_update',
    payload,
  };
}

export function consumeRoutingContext(
  delivery: Exclude<RoutingContextDelivery, { mode: 'none' }>,
  consumerId: string,
  consumedAtMs: number,
): RoutingContextConsumptionReceipt {
  if (!validId(consumerId) || !Number.isSafeInteger(consumedAtMs) || consumedAtMs < 0) throw new Error('invalid_consumption');
  const composedAtMs = Date.parse(delivery.payload.composed_at);
  const expiresAtMs = Date.parse(delivery.payload.expires_at);
  if (!Number.isFinite(composedAtMs) || !Number.isFinite(expiresAtMs) || consumedAtMs < composedAtMs || consumedAtMs >= expiresAtMs) {
    throw new Error('invalid_consumption');
  }
  if (delivery.mode === 'full') {
    if (delivery.payload.producer_generation !== delivery.producer_generation ||
      delivery.payload.context_revision !== delivery.context_revision || delivery.payload.digest !== delivery.digest ||
      !snapshotDigestValid(delivery.payload)) throw new Error('context_revision_conflict');
  } else if (delivery.payload.to_revision !== delivery.context_revision ||
    delivery.payload.from_revision + 1 !== delivery.payload.to_revision) throw new Error('context_revision_conflict');
  if (deliveryDigest(delivery.producer_generation, delivery.context_revision, delivery.digest, delivery.payload) !== delivery.delivery_digest) {
    throw new Error('context_revision_conflict');
  }
  return {
    schema_version: 1,
    consumer_id: consumerId,
    producer_generation: delivery.producer_generation,
    context_revision: delivery.context_revision,
    context_digest: delivery.digest,
    delivery_digest: delivery.delivery_digest,
    delivery_mode: delivery.mode,
    consumed_at: new Date(consumedAtMs).toISOString(),
  };
}
