import type { CodexObservation } from '../codex/types.ts';

export const ROUTING_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CODEX_PROVIDER_AUTHORITY_GENERATION = 1 as const;

export interface RoutingEvidenceProjection {
  schema_version: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  source_revision: number;
  generated_at: string;
  usage: {
    schema_version: 1;
    generated_at: string;
    claude: null;
    codex: CodexObservation;
    grok: null;
  };
  account_generations: Array<{
    account_key: string;
    account_generation: number;
    provider_generation: number;
  }>;
}

export type RoutingEvidenceErrorCode =
  | 'snapshot_busy'
  | 'evidence_unavailable'
  | 'inconsistent_snapshot'
  | 'generation_unavailable';

export class RoutingEvidenceError extends Error {
  constructor(readonly code: RoutingEvidenceErrorCode) {
    super(code);
  }
}
