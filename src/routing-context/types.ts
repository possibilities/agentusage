import type { CatalogAuditInput, CapabilitySet } from '../catalog/types.ts';
import type { FxBrokerBindingReceipt } from '../fx-broker/types.ts';

export const ROUTING_CONTEXT_SCHEMA_VERSION = 1 as const;
export const ROUTING_CONTEXT_FRESHNESS_MS = 5 * 60_000;

export type RoutingContextProvider = 'codex';

export interface ReviewedRoutingModel {
  provider: RoutingContextProvider;
  model_id: string;
  task_fit: string[];
  quota_lane_id: string;
  remaining_capacity_bands: number[];
  cost_guidance: {
    comparison_scope: 'within_provider';
    basis: string;
    unit: string;
    relative_units: number;
  };
}

export interface ReviewedRoutingMetadata {
  schema_version: typeof ROUTING_CONTEXT_SCHEMA_VERSION;
  revision: number;
  catalog: CatalogAuditInput['metadata'];
  guidance: ReviewedRoutingModel[];
}

export interface RoutingContextCurrent {
  provider: RoutingContextProvider;
  model: string;
  effort: string;
  service_tier: string | null;
  broker_lease_id: string;
  execution_id: string;
  attempt_id: string;
  native: {
    process_instance_id: string;
    fx_build_revision: string;
    session_id: string;
  };
}

export interface RoutingContextHost {
  kind: 'host';
  id: string;
  revision: number;
  owner: string;
  serverId: string;
  historyNamespace: string;
  incarnation: string;
  active: boolean;
}

export interface RoutingContextDomain {
  kind: 'domain';
  id: string;
  revision: number;
  hostId: string;
  target: { kind: 'fx_session'; id: string };
  controllerId: string;
  controlEpoch: number;
  allowedActions: Array<'start' | 'steer' | 'interrupt'>;
  scopeId: string;
  active: boolean;
}

export interface RoutingContextInput {
  schema_version: typeof ROUTING_CONTEXT_SCHEMA_VERSION;
  producer_generation: number;
  current: RoutingContextCurrent;
  reviewed: ReviewedRoutingMetadata;
  native_catalog: {
    revision: number;
    catalog: CatalogAuditInput['native_catalog'];
  };
  quota: {
    revision: number;
    usage: Exclude<CatalogAuditInput['usage'], null>;
    account_generations: Array<{
      account_key: string;
      account_generation: number;
      provider_generation: number;
    }>;
  };
  broker_receipts: FxBrokerBindingReceipt[];
  hud: {
    schema_version: 1;
    host: RoutingContextHost;
    domain: RoutingContextDomain;
  };
}

export type RoutingContextTrigger =
  | 'initial'
  | 'heartbeat'
  | 'material_change'
  | 'static_change'
  | 'producer_generation_change';

export interface RoutingContextQuotaAccount {
  account_key: string;
  account_generation: number;
  provider_generation: number;
  broker_lease_id: string | null;
  broker_state: FxBrokerBindingReceipt['state'] | null;
  enabled: boolean;
  auth_status: string;
  decision_grade: boolean;
  eligible: boolean;
  exclusions: string[];
  active_lease_count: number;
  lane: {
    id: string;
    binding: boolean;
    windows: Array<{
      role: string;
      window_seconds: number | null;
      used_percent: number;
      remaining_percent: number;
      resets_at: string | null;
    }>;
  } | null;
}

export interface RoutingContextSnapshot {
  schema_version: typeof ROUTING_CONTEXT_SCHEMA_VERSION;
  producer_generation: number;
  context_revision: number;
  digest: string;
  evidence_digest: string;
  decision_digest: string;
  trigger: RoutingContextTrigger;
  composed_at: string;
  observed_at: string;
  expires_at: string;
  sources: {
    reviewed_revision: number;
    native_catalog_revision: number;
    quota_revision: number;
    broker_incarnation: string;
    broker_revision_digest: string;
    broker_lease_revisions: Array<{ lease_id: string; lease_revision: number; receipt_digest: string }>;
    hud_host_revision: number;
    hud_domain_revision: number;
  };
  source_digests: {
    reviewed: string;
    native_catalog: string;
    quota: string;
    broker: string;
    hud_host: string;
    hud_domain: string;
  };
  current: {
    provider: RoutingContextProvider;
    model: string;
    effort: string;
    service_tier: string | null;
    execution_id: string;
    attempt_id: string;
    broker_lease_id: string;
    native: RoutingContextCurrent['native'];
  };
  guidance: {
    reviewed_version: string;
    task_fit: string[];
    quota_lane_id: string;
    remaining_capacity_bands: number[];
    cost_guidance: ReviewedRoutingModel['cost_guidance'];
    expected_capability_digest: string;
  };
  native_catalog: {
    source: 'codex_app_server_model_list';
    client_version: string;
    capture_id: string;
    capability_digest: string;
    capabilities: CapabilitySet;
  };
  host_control: {
    host_id: string;
    server_id: string;
    history_namespace: string;
    host_incarnation: string;
    domain_id: string;
    controller_id: string;
    control_epoch: number;
    target: { kind: 'fx_session'; id: string };
    scope_id: string;
    allowed_actions: Array<'start' | 'steer' | 'interrupt'>;
  };
  quota: {
    source_revision: number;
    generated_at: string;
    observed_at_ms: number;
    lane_id: string;
    current_account_key: string;
    routing_available: boolean;
    eligible_account_keys: string[];
    accounts: RoutingContextQuotaAccount[];
  };
}

export type RoutingContextErrorCode =
  | 'invalid_input'
  | 'unsupported_provider'
  | 'reviewed_metadata_stale'
  | 'native_catalog_stale'
  | 'quota_evidence_stale'
  | 'broker_receipt_stale'
  | 'ambiguous_join'
  | 'model_join_mismatch'
  | 'capability_join_mismatch'
  | 'account_join_mismatch'
  | 'host_control_join_mismatch'
  | 'source_revision_regressed'
  | 'source_revision_conflict'
  | 'context_revision_conflict';

export type RoutingContextComposeResult =
  | {
      ok: true;
      action: 'published' | 'coalesced';
      snapshot: RoutingContextSnapshot;
    }
  | {
      ok: false;
      error: { code: RoutingContextErrorCode; subject: string | null };
    };

export type RoutingContextDelivery =
  | {
      schema_version: 1;
      mode: 'none';
      producer_generation: number;
      context_revision: number;
      digest: string;
      delivery_digest: null;
      reason: 'already_current';
      payload: null;
    }
  | {
      schema_version: 1;
      mode: 'full';
      producer_generation: number;
      context_revision: number;
      digest: string;
      delivery_digest: string;
      reason: 'initial' | 'revision_gap' | 'producer_generation_change' | 'static_change';
      payload: RoutingContextSnapshot;
    }
  | {
      schema_version: 1;
      mode: 'delta';
      producer_generation: number;
      context_revision: number;
      digest: string;
      delivery_digest: string;
      reason: 'sequential_mutable_update';
      payload: {
        from_revision: number;
        to_revision: number;
        trigger: RoutingContextTrigger;
        composed_at: string;
        observed_at: string;
        expires_at: string;
        quota: RoutingContextSnapshot['quota'];
        broker_revision_digest: string;
      };
    };

export interface RoutingContextConsumptionReceipt {
  schema_version: 1;
  consumer_id: string;
  producer_generation: number;
  context_revision: number;
  context_digest: string;
  delivery_digest: string;
  delivery_mode: 'full' | 'delta';
  consumed_at: string;
}
