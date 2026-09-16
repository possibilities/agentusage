export const CATALOG_AUDIT_SCHEMA_VERSION = 1 as const;
export const CATALOG_AUDIT_MAX_BYTES = 1024 * 1024;

export interface CapabilitySet {
  hidden: boolean;
  efforts: string[];
  default_effort: string;
  service_tiers: string[];
  default_service_tier: string | null;
  is_default: boolean;
  multi_agent_version: string | null;
  input_modalities: string[];
}

export interface CatalogAuditInput {
  schema_version: 1;
  metadata: {
    version: string;
    reviewed_at: string;
    review_after: string;
    sources: string[];
    models: Array<{ model_id: string; expected: CapabilitySet }>;
  };
  native_catalog: {
    source: 'codex_app_server_model_list';
    client_version: string;
    observed_at: string;
    pages: Array<{
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>;
  };
  usage: Record<string, unknown> | null;
}

export interface AuditDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  subject: string | null;
}

export class CatalogInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CatalogInputError';
  }
}
