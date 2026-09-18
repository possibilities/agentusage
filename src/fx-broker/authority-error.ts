import { AccountError } from '../accounts/storage.ts';
import { RoutingEvidenceError } from '../routing-evidence/types.ts';
import type { FxBrokerRefusalCode } from './types.ts';

const SAFE_ACCOUNT_CODES = new Set<FxBrokerRefusalCode>([
  'identity_unavailable',
  'generation_mismatch',
  'generation_unavailable',
  'auth_unavailable',
  'capacity_unavailable',
  'capability_stale',
  'target_mismatch',
  'adapter_unsupported',
  'source_revision_conflict',
  'snapshot_busy',
  'evidence_unavailable',
  'storage_unavailable',
  'cancelled',
  'expired',
  'invalid_request',
]);

export class FxAuthorityPreAdmissionError extends Error {
  constructor(readonly code: FxBrokerRefusalCode) {
    super(code);
  }
}

/** Reduces owner-internal errors to the broker's fixed non-secret code set. */
export function preAdmissionError(error: unknown): FxAuthorityPreAdmissionError {
  if (error instanceof FxAuthorityPreAdmissionError) return error;
  if (error instanceof RoutingEvidenceError) {
    const code = error.code === 'inconsistent_snapshot'
      ? 'evidence_unavailable'
      : error.code;
    return new FxAuthorityPreAdmissionError(code);
  }
  if (error instanceof AccountError) {
    if (SAFE_ACCOUNT_CODES.has(error.code as FxBrokerRefusalCode))
      return new FxAuthorityPreAdmissionError(error.code as FxBrokerRefusalCode);
    if (['unsafe-state', 'invalid-state', 'state-too-large'].includes(error.code))
      return new FxAuthorityPreAdmissionError('storage_unavailable');
    if (error.code === 'credential_revision_conflict')
      return new FxAuthorityPreAdmissionError('auth_unavailable');
    if (error.code === 'invalid_selection' || error.code === 'catalog_drift')
      return new FxAuthorityPreAdmissionError('target_mismatch');
    if (error.code === 'catalog_unavailable' || /^catalog_http_\d{3}$/u.test(error.code))
      return new FxAuthorityPreAdmissionError('evidence_unavailable');
  }
  return new FxAuthorityPreAdmissionError('identity_unavailable');
}
