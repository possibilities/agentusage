export const FX_BROKER_SCHEMA_VERSION = 1 as const;

export type FxBrokerProvider = 'codex' | 'grok';
export type FxBrokerLeaseState =
  | 'prepared'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'released';

export interface FxBrokerOwner {
  host_id: string;
  host_incarnation: string;
  control_epoch: number;
  execution_id: string;
  attempt_id: string;
}

export interface FxBrokerTarget {
  target_id: string;
  target_revision: string;
  provider: FxBrokerProvider;
  model: string;
  effort: string;
  service_tier: string | null;
  protocol: 'openai-responses' | 'grok-responses';
  capability_capture_id: string;
  capability_digest: string;
}

export interface FxBrokerNativeBinding {
  process_instance_id: string;
  fx_build_revision: string;
  session_id: string | null;
}

interface BrokerCommand {
  schema_version: typeof FX_BROKER_SCHEMA_VERSION;
  request_id: string;
  expected_broker_incarnation: string;
}

export interface FxBrokerPrepareCommand extends BrokerCommand {
  owner: FxBrokerOwner;
  target: FxBrokerTarget;
  account: {
    account_key: string;
    expected_account_generation: number;
    expected_provider_generation: number;
  };
  consumer_nonce: string;
  requested_ttl_ms: number;
  execution_deadline_ms: number;
}

export interface FxBrokerActivateCommand extends BrokerCommand {
  lease_id: string;
  capability_token: string;
  expected_lease_revision: number;
  owner: FxBrokerOwner;
  native: FxBrokerNativeBinding;
}

export interface FxBrokerRenewCommand extends BrokerCommand {
  lease_id: string;
  capability_token: string;
  expected_lease_revision: number;
  owner: FxBrokerOwner;
  requested_ttl_ms: number;
}

export interface FxBrokerReleaseCommand extends BrokerCommand {
  lease_id: string;
  capability_token: string;
  expected_lease_revision: number;
  owner: FxBrokerOwner;
}

export interface FxBrokerRevokeCommand extends BrokerCommand {
  lease_id: string;
  reason: 'account_disabled' | 'auth_invalidated' | 'operator' | 'broker_policy';
}

export interface FxBrokerForwardCommand extends BrokerCommand {
  lease_id: string;
  capability_token: string;
  expected_lease_revision: number;
  owner: FxBrokerOwner;
  native: FxBrokerNativeBinding;
  target: FxBrokerTarget;
  operation: 'catalog' | 'inference';
  body: Uint8Array;
  headers: Record<string, string>;
}

export interface FxBrokerBindingReceipt {
  schema_version: typeof FX_BROKER_SCHEMA_VERSION;
  request_id: string;
  lease_id: string;
  binding_id: string;
  binding_digest: string;
  authority_digest: string;
  broker_incarnation: string;
  lease_revision: number;
  state: FxBrokerLeaseState;
  owner: FxBrokerOwner;
  account: {
    provider: FxBrokerProvider;
    account_key: string;
    account_generation: number;
    provider_generation: number;
  };
  target: FxBrokerTarget;
  issued_at_ms: number;
  activate_before_ms: number;
  expires_at_ms: number;
  execution_deadline_ms: number;
  native: FxBrokerNativeBinding | null;
  activation_supported: boolean;
  terminal_reason: string | null;
}

export interface FxBrokerPrivateHandoff {
  schema_version: typeof FX_BROKER_SCHEMA_VERSION;
  lease_id: string;
  broker_incarnation: string;
  capability_token: string;
  activate_before_ms: number;
}

export interface FxBrokerPrepareResult {
  receipt: FxBrokerBindingReceipt;
  handoff: FxBrokerPrivateHandoff | null;
  replayed: boolean;
}

export interface FxBrokerRefusal {
  schema_version: typeof FX_BROKER_SCHEMA_VERSION;
  request_id: string;
  code:
    | 'identity_unavailable'
    | 'generation_mismatch'
    | 'auth_unavailable'
    | 'refresh_outcome_unknown'
    | 'capacity_unavailable'
    | 'capability_stale'
    | 'target_mismatch'
    | 'adapter_unsupported'
    | 'stale_fence'
    | 'expired'
    | 'revoked'
    | 'released'
    | 'idempotency_conflict'
    | 'broker_unavailable'
    | 'invalid_request';
  disposition: 'refused' | 'outcome_unknown';
  retry: 'none' | 'same_command' | 'new_authorized_attempt';
  provider_delivery: 'not_forwarded' | 'may_have_forwarded';
  message: string;
}

export interface FxBrokerProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface FxBrokerForwardResult {
  receipt: {
    schema_version: typeof FX_BROKER_SCHEMA_VERSION;
    request_id: string;
    lease_id: string;
    binding_id: string;
    lease_revision: number;
    disposition: 'forwarded' | 'outcome_unknown';
    provider_delivery: 'forwarded' | 'may_have_forwarded';
  };
  response: FxBrokerProviderResponse | null;
  replayed: boolean;
}

export interface FxBrokerAuthorityAccount {
  provider: FxBrokerProvider;
  account_key: string;
  account_generation: number;
  provider_generation: number;
  credential_revision: number;
  enabled: boolean;
  auth_available: boolean;
  target: FxBrokerTarget;
  activation_supported: boolean;
}

export interface FxBrokerAuthorityForwardResult {
  account_generation: number;
  provider_generation: number;
  credential_revision: number;
  response: FxBrokerProviderResponse;
}

/**
 * Implemented inside AgentUsage. Provider credentials and refresh results stay
 * behind this interface and never enter broker commands, receipts, or state.
 */
export interface FxBrokerAuthority {
  inspect(
    provider: FxBrokerProvider,
    accountKey: string,
  ): Promise<FxBrokerAuthorityAccount>;
  forward(
    account: FxBrokerAuthorityAccount,
    request: {
      operation: 'catalog' | 'inference';
      target: FxBrokerTarget;
      body: Uint8Array;
      headers: Record<string, string>;
    },
  ): Promise<FxBrokerAuthorityForwardResult>;
}
