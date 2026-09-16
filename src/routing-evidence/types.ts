import type { CodexObservation } from '../codex/types.ts';
import type { GrokObservation } from '../grok/types.ts';

export const ROUTING_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const CODEX_PROVIDER_AUTHORITY_GENERATION = 1 as const;
export const GROK_PROVIDER_AUTHORITY_GENERATION = 1 as const;

export interface RoutingEvidenceProjection {
  schema_version: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  /** Monotonic Cantor pairing of both provider revisions, encoded losslessly. */
  source_revision: string;
  provider_source_revisions: {
    codex: number;
    grok: number;
  };
  generated_at: string;
  usage: {
    schema_version: 1;
    generated_at: string;
    claude: null;
    codex: CodexObservation;
    grok: GrokObservation;
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
