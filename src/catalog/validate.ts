import { validateCodexObservation } from '../codex/types.ts';
import {
  COLLECTOR_PROFILE,
  SUPPORTED_COLLECTOR_VERSION,
  CatalogInputError,
  type CapabilitySet,
  type CatalogAuditInput,
  type CatalogCaptureReceipt,
} from './types.ts';

const MAX_STRING = 512;
const MAX_SOURCE = 2048;
const MAX_ARRAY = 512;
const MAX_PAGES = 128;
const MAX_ACCOUNTS = 256;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

function record(value: unknown, code = 'invalid-bundle'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CatalogInputError(code);
  return value as Record<string, unknown>;
}

function string(value: unknown, code = 'invalid-bundle', max = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new CatalogInputError(code);
  return value;
}

function nullableString(value: unknown, code = 'invalid-bundle'): string | null {
  return value === null ? null : string(value, code);
}

function iso(value: unknown, code = 'invalid-bundle'): string {
  const result = string(value, code);
  const match = RFC3339.exec(result);
  if (match === null || !Number.isFinite(Date.parse(result))) throw new CatalogInputError(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw new CatalogInputError(code);
  return result;
}

function array(value: unknown, code = 'invalid-bundle', max = MAX_ARRAY): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new CatalogInputError(code);
  return value;
}

function stringArray(value: unknown, code = 'invalid-bundle'): string[] {
  const result = array(value, code).map((entry) => string(entry, code));
  if (new Set(result).size !== result.length) throw new CatalogInputError(code);
  return result;
}

function capability(value: unknown): CapabilitySet {
  const raw = record(value);
  if (typeof raw.hidden !== 'boolean' || typeof raw.is_default !== 'boolean') throw new CatalogInputError('invalid-metadata');
  const result = {
    hidden: raw.hidden,
    efforts: stringArray(raw.efforts, 'invalid-metadata'),
    default_effort: string(raw.default_effort, 'invalid-metadata'),
    service_tiers: stringArray(raw.service_tiers, 'invalid-metadata'),
    default_service_tier: nullableString(raw.default_service_tier, 'invalid-metadata'),
    is_default: raw.is_default,
    multi_agent_version: nullableString(raw.multi_agent_version, 'invalid-metadata'),
    input_modalities: stringArray(raw.input_modalities, 'invalid-metadata'),
  };
  if (!result.efforts.includes(result.default_effort)) throw new CatalogInputError('invalid-metadata');
  if (result.default_service_tier !== null && !result.service_tiers.includes(result.default_service_tier)) throw new CatalogInputError('invalid-metadata');
  return result;
}

function validateNativeRow(value: unknown): Record<string, unknown> {
  const row = record(value, 'invalid-native-catalog');
  string(row.model, 'invalid-native-catalog');
  if (typeof row.hidden !== 'boolean' || typeof row.isDefault !== 'boolean') throw new CatalogInputError('invalid-native-catalog');
  string(row.defaultReasoningEffort, 'invalid-native-catalog');
  nullableString(row.defaultServiceTier, 'invalid-native-catalog');
  nullableString(row.multiAgentVersion, 'invalid-native-catalog');
  stringArray(row.inputModalities, 'invalid-native-catalog');
  const efforts = array(row.supportedReasoningEfforts, 'invalid-native-catalog').map((effort) => string(record(effort, 'invalid-native-catalog').reasoningEffort, 'invalid-native-catalog'));
  if (new Set(efforts).size !== efforts.length || !efforts.includes(row.defaultReasoningEffort as string)) throw new CatalogInputError('invalid-native-catalog');
  let tiers: string[];
  if (row.serviceTiers !== undefined) {
    tiers = array(row.serviceTiers, 'invalid-native-catalog').map((tier) => string(record(tier, 'invalid-native-catalog').id, 'invalid-native-catalog'));
    if (new Set(tiers).size !== tiers.length) throw new CatalogInputError('invalid-native-catalog');
  } else tiers = row.additionalSpeedTiers === undefined ? [] : stringArray(row.additionalSpeedTiers, 'invalid-native-catalog');
  if (row.additionalSpeedTiers !== undefined) stringArray(row.additionalSpeedTiers, 'invalid-native-catalog');
  if (row.defaultServiceTier !== null && !tiers.includes(row.defaultServiceTier as string)) throw new CatalogInputError('invalid-native-catalog');
  return row;
}

function validateCaptureReceipt(
  value: unknown,
  pages: CatalogAuditInput['native_catalog']['pages'],
  clientVersion: string,
  observedAt: string,
): CatalogCaptureReceipt {
  const raw = record(value, 'invalid-capture-receipt');
  if (raw.schema_version !== 1 || raw.profile !== COLLECTOR_PROFILE ||
      raw.expected_version !== SUPPORTED_COLLECTOR_VERSION || raw.reported_version !== SUPPORTED_COLLECTOR_VERSION ||
      raw.complete !== true || clientVersion !== raw.reported_version ||
      typeof raw.capture_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw.capture_id)) {
    throw new CatalogInputError('invalid-capture-receipt');
  }
  const startedAt = iso(raw.started_at, 'invalid-capture-receipt');
  const completedAt = iso(raw.completed_at, 'invalid-capture-receipt');
  if (Date.parse(startedAt) > Date.parse(completedAt) || completedAt !== observedAt) throw new CatalogInputError('invalid-capture-receipt');
  const receiptPages = array(raw.pages, 'invalid-capture-receipt', MAX_PAGES);
  if (receiptPages.length !== pages.length || pages.at(-1)?.nextCursor !== null) throw new CatalogInputError('invalid-capture-receipt');
  for (const capturePage of pages) {
    for (const row of capturePage.data) {
      if (!Object.hasOwn(row, 'serviceTiers') || !Object.hasOwn(row, 'supportedReasoningEfforts') ||
          !Object.hasOwn(row, 'inputModalities') || !Object.hasOwn(row, 'multiAgentVersion') ||
          !Object.hasOwn(row, 'defaultServiceTier')) throw new CatalogInputError('invalid-capture-receipt');
      string(row.id, 'invalid-capture-receipt');
      if (row.multiAgentVersion !== null && row.multiAgentVersion !== 'disabled' && row.multiAgentVersion !== 'v1' && row.multiAgentVersion !== 'v2') {
        throw new CatalogInputError('invalid-capture-receipt');
      }
      const modalities = row.inputModalities as string[];
      if (modalities.some((modality) => modality !== 'text' && modality !== 'image' && modality !== 'audio')) {
        throw new CatalogInputError('invalid-capture-receipt');
      }
    }
  }
  const normalized = receiptPages.map((entry, index) => {
    const page = record(entry, 'invalid-capture-receipt');
    const expectedCursor = index === 0 ? null : pages[index - 1]!.nextCursor;
    if (page.request_id !== index + 2 || page.requested_cursor !== expectedCursor ||
        page.returned_next_cursor !== pages[index]!.nextCursor || page.include_hidden !== true ||
        page.limit !== 100 || !Number.isSafeInteger(page.model_count) || (page.model_count as number) < 0 ||
        (page.model_count as number) > 100 || page.model_count !== pages[index]!.data.length) throw new CatalogInputError('invalid-capture-receipt');
    return {
      request_id: index + 2,
      requested_cursor: expectedCursor,
      returned_next_cursor: pages[index]!.nextCursor,
      include_hidden: true as const,
      limit: 100 as const,
      model_count: pages[index]!.data.length,
    };
  });
  return {
    schema_version: 1,
    profile: COLLECTOR_PROFILE,
    capture_id: raw.capture_id,
    expected_version: SUPPORTED_COLLECTOR_VERSION,
    reported_version: SUPPORTED_COLLECTOR_VERSION,
    started_at: startedAt,
    completed_at: completedAt,
    complete: true,
    pages: normalized,
  };
}

export function validateCatalogMetadataInput(value: unknown): CatalogAuditInput['metadata'] {
  const raw = record(value, 'invalid-metadata-input');
  if (raw.schema_version !== 1 || !('metadata' in raw)) throw new CatalogInputError('invalid-metadata-input');
  return validateCatalogAuditInput({
    schema_version: 1,
    metadata: raw.metadata,
    native_catalog: {
      source: 'codex_app_server_model_list',
      client_version: SUPPORTED_COLLECTOR_VERSION,
      observed_at: new Date().toISOString(),
      pages: [{ data: [], nextCursor: null }],
    },
    usage: null,
  }).metadata;
}

export function validateCatalogAuditInput(value: unknown): CatalogAuditInput {
  const top = record(value);
  if (top.schema_version !== 1) throw new CatalogInputError('unsupported-schema-version');
  const metadataRaw = record(top.metadata, 'invalid-metadata');
  const reviewedAt = iso(metadataRaw.reviewed_at, 'invalid-metadata');
  const reviewAfter = iso(metadataRaw.review_after, 'invalid-metadata');
  if (Date.parse(reviewedAt) > Date.parse(reviewAfter)) throw new CatalogInputError('invalid-metadata');
  const modelIds = new Set<string>();
  const models = array(metadataRaw.models, 'invalid-metadata').map((entry) => {
    const raw = record(entry, 'invalid-metadata');
    const model_id = string(raw.model_id, 'invalid-metadata');
    if (modelIds.has(model_id)) throw new CatalogInputError('duplicate-metadata-model');
    modelIds.add(model_id);
    return { model_id, expected: capability(raw.expected) };
  });
  const sources = array(metadataRaw.sources, 'invalid-metadata').map((entry) => string(entry, 'invalid-metadata', MAX_SOURCE));
  if (sources.length === 0) throw new CatalogInputError('invalid-metadata');
  const nativeRaw = record(top.native_catalog, 'invalid-native-catalog');
  if (nativeRaw.source !== 'codex_app_server_model_list') throw new CatalogInputError('invalid-native-source');
  const pagesRaw = array(nativeRaw.pages, 'invalid-native-catalog', MAX_PAGES);
  if (pagesRaw.length === 0) throw new CatalogInputError('incomplete-native-pages');
  const cursors = new Set<string>();
  const nativeModels = new Set<string>();
  let nativeModelCount = 0;
  const pages = pagesRaw.map((entry, index) => {
    const raw = record(entry, 'invalid-native-catalog');
    const data = array(raw.data, 'invalid-native-catalog').map(validateNativeRow);
    nativeModelCount += data.length;
    if (nativeModelCount > MAX_ARRAY) throw new CatalogInputError('invalid-native-catalog');
    for (const row of data) {
      const id = row.model as string;
      if (nativeModels.has(id)) throw new CatalogInputError('duplicate-native-model');
      nativeModels.add(id);
    }
    const nextCursor = nullableString(raw.nextCursor, 'invalid-native-catalog');
    if (index < pagesRaw.length - 1 && nextCursor === null) throw new CatalogInputError('incomplete-native-pages');
    if (nextCursor !== null) {
      if (cursors.has(nextCursor)) throw new CatalogInputError('repeated-native-cursor');
      cursors.add(nextCursor);
    }
    return { data, nextCursor };
  });
  const clientVersion = string(nativeRaw.client_version, 'invalid-native-catalog');
  const observedAt = iso(nativeRaw.observed_at, 'invalid-native-catalog');
  const captureReceipt = nativeRaw.capture_receipt === undefined
    ? undefined
    : validateCaptureReceipt(nativeRaw.capture_receipt, pages, clientVersion, observedAt);

  let usage: Record<string, unknown> | null = null;
  if (top.usage !== null) {
    const raw = record(top.usage, 'invalid-usage');
    if (raw.schema_version !== 1) throw new CatalogInputError('invalid-usage');
    iso(raw.generated_at, 'invalid-usage');
    if (!('claude' in raw) || !('codex' in raw) || !('grok' in raw) ||
        (raw.claude !== null && (typeof raw.claude !== 'object' || Array.isArray(raw.claude))) ||
        (raw.grok !== null && (typeof raw.grok !== 'object' || Array.isArray(raw.grok))) ||
        (raw.codex !== null && validateCodexObservation(raw.codex) === null)) throw new CatalogInputError('invalid-usage');
    const observation = raw.codex === null ? null : record(raw.codex, 'invalid-usage');
    if (observation !== null) {
      if (!Number.isSafeInteger(observation.observed_at_ms) || (observation.observed_at_ms as number) < 0 ||
          !['ok', 'absent', 'stale', 'malformed', 'unsupported', 'error'].includes(observation.health as string)) throw new CatalogInputError('invalid-usage');
      const accounts = array(observation.accounts, 'invalid-usage', MAX_ACCOUNTS);
      const accountKeys = new Set<string>();
      for (const candidate of accounts) {
        const account = record(candidate, 'invalid-usage');
        const key = string(account.accountKey, 'invalid-usage');
        if (!/^codex-[1-9]\d*$/u.test(key)) throw new CatalogInputError('invalid-usage');
        if (accountKeys.has(key)) throw new CatalogInputError('duplicate-usage-account');
        accountKeys.add(key);
        if (typeof account.enabled !== 'boolean' || typeof account.decisionGrade !== 'boolean') throw new CatalogInputError('invalid-usage');
        string(account.authStatus, 'invalid-usage');
        if (account.measurementSource !== null && account.measurementSource !== 'current' && account.measurementSource !== 'last-good') throw new CatalogInputError('invalid-usage');
        if (account.measuredAtMs !== null && (typeof account.measuredAtMs !== 'number' || !Number.isSafeInteger(account.measuredAtMs) || account.measuredAtMs < 0)) throw new CatalogInputError('invalid-usage');
        if (account.headroomPercent !== null && (typeof account.headroomPercent !== 'number' || !Number.isFinite(account.headroomPercent) || account.headroomPercent < 0 || account.headroomPercent > 100)) throw new CatalogInputError('invalid-usage');
        if (!Number.isSafeInteger(account.activeLeases) || (account.activeLeases as number) < 0) throw new CatalogInputError('invalid-usage');
        stringArray(account.exclusions, 'invalid-usage');
        for (const laneValue of array(account.lanes, 'invalid-usage')) {
          const lane = record(laneValue, 'invalid-usage');
          string(lane.id, 'invalid-usage');
          if (typeof lane.binding !== 'boolean') throw new CatalogInputError('invalid-usage');
          const windows = array(lane.windows, 'invalid-usage');
          for (const windowValue of windows) {
            const window = record(windowValue, 'invalid-usage');
            if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 ||
                typeof window.remainingPercent !== 'number' || !Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100) throw new CatalogInputError('invalid-usage');
            if (window.windowSeconds !== null && (!Number.isSafeInteger(window.windowSeconds) || (window.windowSeconds as number) <= 0)) throw new CatalogInputError('invalid-usage');
            if (window.resetAfterSeconds !== null && (typeof window.resetAfterSeconds !== 'number' || !Number.isFinite(window.resetAfterSeconds) || window.resetAfterSeconds < 0)) throw new CatalogInputError('invalid-usage');
            if (window.resetsAt !== null) iso(window.resetsAt, 'invalid-usage');
          }
        }
        const laneIds = (account.lanes as Array<Record<string, unknown>>).map((lane) => lane.id as string);
        if (new Set(laneIds).size !== laneIds.length) throw new CatalogInputError('invalid-usage');
      }
    }
    usage = raw;
  } else if (!('usage' in top)) {
    throw new CatalogInputError('invalid-bundle');
  }

  return {
    schema_version: 1,
    metadata: {
      version: string(metadataRaw.version, 'invalid-metadata'),
      reviewed_at: reviewedAt,
      review_after: reviewAfter,
      sources,
      models,
    },
    native_catalog: {
      source: 'codex_app_server_model_list',
      client_version: clientVersion,
      observed_at: observedAt,
      pages,
      ...(captureReceipt === undefined ? {} : { capture_receipt: captureReceipt }),
    },
    usage,
  };
}
