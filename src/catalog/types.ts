export const CATALOG_AUDIT_SCHEMA_VERSION = 1 as const;
export const CATALOG_AUDIT_MAX_BYTES = 1024 * 1024;
export const SUPPORTED_COLLECTOR_VERSION = '0.154.0' as const;
export const COLLECTOR_PROFILE = 'stock-codex-app-server-0.154.0' as const;

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
    capture_receipt?: CatalogCaptureReceipt;
  };
  usage: Record<string, unknown> | null;
}

export interface CatalogCaptureReceipt {
  schema_version: 1;
  profile: typeof COLLECTOR_PROFILE;
  capture_id: string;
  expected_version: typeof SUPPORTED_COLLECTOR_VERSION;
  reported_version: typeof SUPPORTED_COLLECTOR_VERSION;
  started_at: string;
  completed_at: string;
  complete: true;
  pages: Array<{
    request_id: number;
    requested_cursor: string | null;
    returned_next_cursor: string | null;
    include_hidden: true;
    limit: 100;
    model_count: number;
  }>;
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
