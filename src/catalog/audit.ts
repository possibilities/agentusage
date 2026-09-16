import { createHash } from 'node:crypto';
import type { CodexAccountView, CodexLane, CodexObservation } from '../codex/types.ts';
import type { AuditDiagnostic, CapabilitySet, CatalogAuditInput } from './types.ts';

/** Capture clocks may lead the auditor by at most normal local clock jitter. */
const FUTURE_TOLERANCE_MS = 5_000;
/** Native catalog and public usage evidence share the observation freshness ceiling. */
const NATIVE_FRESHNESS_MS = 5 * 60_000;
const USAGE_FRESHNESS_MS = 5 * 60_000;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function normalize(capability: CapabilitySet): CapabilitySet {
  return { ...capability, efforts: sorted(capability.efforts), service_tiers: sorted(capability.service_tiers), input_modalities: sorted(capability.input_modalities) };
}

function fingerprint(capability: CapabilitySet): string {
  return createHash('sha256').update(JSON.stringify(normalize(capability))).digest('hex');
}

function changedFields(expected: CapabilitySet, reported: CapabilitySet): string[] {
  const left = normalize(expected) as unknown as Record<string, unknown>;
  const right = normalize(reported) as unknown as Record<string, unknown>;
  return Object.keys(left).filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

function nativeCapability(row: Record<string, unknown>): CapabilitySet {
  const serviceTiers = row.serviceTiers as Array<Record<string, unknown>> | undefined;
  const fallback = row.additionalSpeedTiers as string[] | undefined;
  return normalize({
    hidden: row.hidden as boolean,
    efforts: (row.supportedReasoningEfforts as Array<Record<string, unknown>>).map((entry) => entry.reasoningEffort as string),
    default_effort: row.defaultReasoningEffort as string,
    service_tiers: serviceTiers !== undefined ? serviceTiers.map((entry) => entry.id as string) : (fallback ?? []),
    default_service_tier: row.defaultServiceTier as string | null,
    is_default: row.isDefault as boolean,
    multi_agent_version: row.multiAgentVersion as string | null,
    input_modalities: row.inputModalities as string[],
  });
}

function diagnostic(diagnostics: AuditDiagnostic[], code: string, subject: string | null = null, severity: 'warning' | 'error' = 'warning'): void {
  diagnostics.push({ code, severity, subject });
}

function timeDiagnostics(diagnostics: AuditDiagnostic[], label: string, timestamp: string | number, nowMs: number, maxAgeMs: number): void {
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (time > nowMs + FUTURE_TOLERANCE_MS) diagnostic(diagnostics, `${label}_future`);
  else if (nowMs - time > maxAgeMs) diagnostic(diagnostics, `${label}_stale`);
}

function sanitizeLane(lane: CodexLane) {
  return {
    id: lane.id,
    binding: lane.binding,
    windows: lane.windows.map((window) => ({
      role: window.role,
      window_seconds: window.windowSeconds,
      used_percent: window.usedPercent,
      remaining_percent: window.remainingPercent,
      resets_at: window.resetsAt,
      reset_after_seconds: window.resetAfterSeconds,
    })),
  };
}

function sanitizeAccount(account: CodexAccountView, nowMs: number, publicationFresh: boolean, observation: CodexObservation) {
  const freshCurrent = account.measurementSource === 'current' && account.measuredAtMs !== null &&
    account.measuredAtMs <= nowMs + FUTURE_TOLERANCE_MS && nowMs - account.measuredAtMs <= USAGE_FRESHNESS_MS;
  const resetCrossed = account.measuredAtMs !== null && account.lanes.some((lane) => lane.windows.some((window) =>
    window.resetsAt !== null && Date.parse(window.resetsAt) <= nowMs && account.measuredAtMs! < Date.parse(window.resetsAt)));
  return {
    account_key: account.accountKey,
    enabled: account.enabled,
    auth_status: account.authStatus,
    reported_decision_grade: account.decisionGrade,
    decision_grade: account.decisionGrade && publicationFresh && observation.health === 'ok' && freshCurrent && !resetCrossed,
    measurement_source: account.measurementSource,
    measured_at_ms: account.measuredAtMs,
    lanes: account.lanes.map(sanitizeLane),
    headroom_percent: account.headroomPercent,
    exclusions: [...account.exclusions],
    active_lease_count: account.activeLeases,
  };
}

export function auditCatalog(input: CatalogAuditInput, nowMs = Date.now()) {
  const diagnostics: AuditDiagnostic[] = [];
  if (Date.parse(input.metadata.review_after) < nowMs) diagnostic(diagnostics, 'metadata_review_overdue');
  if (Date.parse(input.metadata.reviewed_at) > nowMs + FUTURE_TOLERANCE_MS) diagnostic(diagnostics, 'metadata_review_future');
  timeDiagnostics(diagnostics, 'native_catalog', input.native_catalog.observed_at, nowMs, NATIVE_FRESHNESS_MS);

  const authored = new Map(input.metadata.models.map((entry) => [entry.model_id, normalize(entry.expected)]));
  const native = new Map<string, CapabilitySet>();
  const nativeRows = new Map<string, Record<string, unknown>>();
  for (const page of input.native_catalog.pages) for (const row of page.data) native.set(row.model as string, nativeCapability(row));
  for (const page of input.native_catalog.pages) for (const row of page.data) nativeRows.set(row.model as string, row);
  const complete = input.native_catalog.pages.at(-1)!.nextCursor === null;
  if (!complete) diagnostic(diagnostics, 'native_catalog_incomplete');
  const modelIds = sorted([...new Set([...authored.keys(), ...native.keys()])]);
  const models = modelIds.map((modelId) => {
    const expected = authored.get(modelId) ?? null;
    const reported = native.get(modelId) ?? null;
    let status: 'match' | 'metadata_missing' | 'model_unavailable' | 'capability_drift' | 'evidence_incomplete';
    if (expected === null) status = 'metadata_missing';
    else if (reported === null) status = complete ? 'model_unavailable' : 'evidence_incomplete';
    else if (fingerprint(expected) !== fingerprint(reported)) status = 'capability_drift';
    else status = 'match';
    if (status !== 'match') diagnostic(diagnostics, status, modelId, status === 'capability_drift' ? 'error' : 'warning');
    return {
      model_id: modelId,
      status,
      changed_fields: expected !== null && reported !== null ? changedFields(expected, reported) : [],
      authored: expected === null ? null : { capabilities: expected, fingerprint: fingerprint(expected) },
      native: reported === null ? null : {
        capabilities: reported,
        fingerprint: fingerprint(reported),
        service_tier_source: nativeRows.get(modelId)!.serviceTiers === undefined ? 'deprecated_additional_speed_tiers' : 'service_tiers',
      },
    };
  });

  let quota: object;
  if (input.usage === null) {
    diagnostic(diagnostics, 'usage_missing');
    quota = { supplied: false, generated_at: null, observed_at_ms: null, health: null, accounts: [] };
  } else {
    const generatedAt = input.usage.generated_at as string;
    timeDiagnostics(diagnostics, 'usage', generatedAt, nowMs, USAGE_FRESHNESS_MS);
    const observation = input.usage.codex as CodexObservation | null;
    if (observation === null) {
      diagnostic(diagnostics, 'codex_usage_missing');
      quota = { supplied: true, generated_at: generatedAt, observed_at_ms: null, health: null, accounts: [] };
    } else {
      timeDiagnostics(diagnostics, 'measurement', observation.observed_at_ms, nowMs, USAGE_FRESHNESS_MS);
      if (observation.health !== 'ok') diagnostic(diagnostics, 'usage_health_not_ok');
      const accounts = [...observation.accounts].sort((a, b) => a.accountKey.localeCompare(b.accountKey));
      for (const account of accounts) {
        if (account.measurementSource === 'last-good') diagnostic(diagnostics, 'last_good_measurement', account.accountKey);
        if (account.measuredAtMs === null) diagnostic(diagnostics, 'measurement_missing', account.accountKey);
        else {
          timeDiagnostics(diagnostics, 'account_measurement', account.measuredAtMs, nowMs, USAGE_FRESHNESS_MS);
          for (const lane of account.lanes) for (const window of lane.windows) {
            if (window.resetsAt !== null && Date.parse(window.resetsAt) <= nowMs && account.measuredAtMs < Date.parse(window.resetsAt)) {
              diagnostic(diagnostics, 'reset_crossed_refresh_required', account.accountKey);
            }
          }
        }
      }
      const publicationTime = Date.parse(generatedAt);
      const publicationFresh = publicationTime <= nowMs + FUTURE_TOLERANCE_MS && nowMs - publicationTime <= USAGE_FRESHNESS_MS &&
        observation.observed_at_ms <= nowMs + FUTURE_TOLERANCE_MS && nowMs - observation.observed_at_ms <= USAGE_FRESHNESS_MS;
      quota = { supplied: true, generated_at: generatedAt, observed_at_ms: observation.observed_at_ms, health: observation.health, accounts: accounts.map((account) => sanitizeAccount(account, nowMs, publicationFresh, observation)) };
    }
  }
  diagnostics.sort((a, b) => a.code.localeCompare(b.code) || (a.subject ?? '').localeCompare(b.subject ?? ''));
  return {
    schema_version: 1,
    ok: diagnostics.length === 0,
    generated_at: new Date(nowMs).toISOString(),
    metadata: { version: input.metadata.version, reviewed_at: input.metadata.reviewed_at, review_after: input.metadata.review_after, sources: [...input.metadata.sources], model_count: authored.size },
    native_catalog: {
      source: input.native_catalog.source,
      client_version: input.native_catalog.client_version,
      observed_at: input.native_catalog.observed_at,
      complete,
      page_count: input.native_catalog.pages.length,
      model_count: native.size,
      capture_receipt: input.native_catalog.capture_receipt ?? null,
      provenance: input.native_catalog.capture_receipt === undefined
        ? 'supplied capture; cursor request continuity cannot be proven offline'
        : 'collector receipt validates supplied page continuity but is not cryptographic attestation',
    },
    models,
    quota,
    identity_correlation: 'unavailable' as const,
    routing_enabled: false as const,
    selection: null,
    limitations: ['captures_are_not_native_execution_proof', 'account_identity_correlation_unavailable', 'unknown_economics_remain_unknown'],
    diagnostics,
  };
}
