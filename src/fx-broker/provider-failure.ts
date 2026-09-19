import { record } from '../accounts/storage.ts';

const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_RAW_CODE_BYTES = 64;

export const FX_PROVIDER_ERROR_CODES = [
  'authentication_failed',
  'permission_denied',
  'rate_limit_exceeded',
  'quota_exhausted',
  'invalid_request',
  'model_unavailable',
  'server_error',
] as const;

export type FxProviderErrorCode = (typeof FX_PROVIDER_ERROR_CODES)[number];

const aliases = new Map<string, FxProviderErrorCode>([
  ['authentication_error', 'authentication_failed'],
  ['authentication_failed', 'authentication_failed'],
  ['invalid_api_key', 'authentication_failed'],
  ['invalid_auth', 'authentication_failed'],
  ['unauthenticated', 'authentication_failed'],
  ['unauthorized', 'authentication_failed'],
  ['forbidden', 'permission_denied'],
  ['insufficient_permission', 'permission_denied'],
  ['insufficient_permissions', 'permission_denied'],
  ['permission_denied', 'permission_denied'],
  ['rate_limit_exceeded', 'rate_limit_exceeded'],
  ['rate_limited', 'rate_limit_exceeded'],
  ['too_many_requests', 'rate_limit_exceeded'],
  ['insufficient_quota', 'quota_exhausted'],
  ['quota_exceeded', 'quota_exhausted'],
  ['quota_exhausted', 'quota_exhausted'],
  ['bad_request', 'invalid_request'],
  ['invalid_request', 'invalid_request'],
  ['invalid_request_error', 'invalid_request'],
  ['model_not_found', 'model_unavailable'],
  ['model_unavailable', 'model_unavailable'],
  ['internal_server_error', 'server_error'],
  ['server_error', 'server_error'],
  ['service_unavailable', 'server_error'],
]);

export function validProviderHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
}

export function validProviderErrorCode(value: unknown): value is FxProviderErrorCode {
  return typeof value === 'string' &&
    (FX_PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Converts only a small, reviewed vocabulary of machine codes. Arbitrary
 * provider text, identifiers and messages never become broker evidence.
 */
export function normalizeProviderErrorCode(value: unknown): FxProviderErrorCode | null {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_RAW_CODE_BYTES ||
    !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value)
  ) return null;
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[.-]+/gu, '_')
    .toLowerCase();
  return aliases.get(normalized) ?? null;
}

/** Reads only fixed code fields from a bounded JSON error envelope. */
export function providerErrorCodeFromBody(bytes: Uint8Array): FxProviderErrorCode | null {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ERROR_BODY_BYTES) return null;
  let value: Record<string, unknown> | null;
  try {
    value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
  if (!value || Object.keys(value).length > 16) return null;
  const error = record(value.error);
  if (error && Object.keys(error).length > 16) return null;
  for (const candidate of [
    error?.code,
    error?.type,
    value.code,
    typeof value.error === 'string' ? value.error : null,
  ]) {
    const normalized = normalizeProviderErrorCode(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/** Fixed post-admission diagnostic; never retains the source error or body. */
export class FxAuthorityResponseError extends Error {
  readonly provider_http_status: number;
  readonly provider_error_code: FxProviderErrorCode | null;

  constructor(providerHttpStatus: number, providerErrorCode: FxProviderErrorCode | null) {
    if (!validProviderHttpStatus(providerHttpStatus))
      throw new TypeError('Invalid provider HTTP status');
    if (providerErrorCode !== null && !validProviderErrorCode(providerErrorCode))
      throw new TypeError('Invalid provider error code');
    super('Provider response handling failed');
    this.name = 'FxAuthorityResponseError';
    this.provider_http_status = providerHttpStatus;
    this.provider_error_code = providerErrorCode;
  }
}
