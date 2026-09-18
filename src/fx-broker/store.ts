import { join } from 'node:path';
import type { StatePaths } from '../paths.ts';
import {
  AccountError,
  checkPrivateDirectory,
  privateDirectory,
  readPrivate,
  record,
  withLock,
  writePrivate,
} from '../accounts/storage.ts';
import type {
  FxBrokerBindingReceipt,
  FxBrokerLeaseState,
  FxBrokerNativeBinding,
  FxBrokerOwner,
  FxBrokerTarget,
} from './types.ts';

export interface DurableFxBrokerLease {
  lease_id: string;
  binding_id: string;
  capability_hash: string;
  binding_digest: string;
  authority_digest: string;
  broker_incarnation: string;
  lease_revision: number;
  state: FxBrokerLeaseState;
  owner: FxBrokerOwner;
  account: {
    provider: 'codex' | 'grok';
    account_key: string;
    account_generation: number;
    provider_generation: number;
    credential_revision: number;
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

export interface DurableFxBrokerOperation {
  request_id: string;
  request_digest: string;
  kind: 'prepare' | 'activate' | 'renew' | 'release' | 'revoke' | 'forward';
  lease_id: string;
  status: 'applied' | 'refused' | 'outcome_unknown';
  result: Record<string, unknown>;
}

export interface FxBrokerState {
  schema_version: 1;
  broker_epoch: number;
  broker_incarnation: string;
  leases: DurableFxBrokerLease[];
  operations: DurableFxBrokerOperation[];
}

const directory = (paths: StatePaths) => join(paths.stateRoot, 'service');
export const fxBrokerStateFile = (paths: StatePaths) =>
  join(directory(paths), 'fx-broker.json');
const fxBrokerLockFile = (paths: StatePaths) =>
  join(directory(paths), 'fx-broker.lock');

const emptyState = (): FxBrokerState => ({
  schema_version: 1,
  broker_epoch: 0,
  broker_incarnation: 'uninitialized',
  leases: [],
  operations: [],
});

function safeInteger(value: unknown, minimum = 0): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function bounded(value: unknown, maximum = 256): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

const REFUSAL_CODES = new Set([
  'identity_unavailable',
  'generation_mismatch',
  'generation_unavailable',
  'auth_unavailable',
  'refresh_outcome_unknown',
  'capacity_unavailable',
  'capability_stale',
  'target_mismatch',
  'adapter_unsupported',
  'source_revision_conflict',
  'snapshot_busy',
  'evidence_unavailable',
  'storage_unavailable',
  'cancelled',
  'stale_fence',
  'expired',
  'revoked',
  'released',
  'idempotency_conflict',
  'broker_unavailable',
  'invalid_request',
]);

function validOwner(value: unknown): boolean {
  const owner = record(value);
  return Boolean(
    owner &&
      Object.keys(owner).length === 5 &&
      bounded(owner.host_id) &&
      bounded(owner.host_incarnation) &&
      safeInteger(owner.control_epoch, 1) &&
      bounded(owner.execution_id) &&
      bounded(owner.attempt_id),
  );
}

function validTarget(value: unknown): boolean {
  const target = record(value);
  if (!target || Object.keys(target).length !== 9) return false;
  return Boolean(
    bounded(target.target_id) &&
      bounded(target.target_revision) &&
      (target.provider === 'codex' || target.provider === 'grok') &&
      bounded(target.model) &&
      bounded(target.effort) &&
      (target.service_tier === null || bounded(target.service_tier)) &&
      ((target.provider === 'codex' &&
        target.protocol === 'openai-responses') ||
        (target.provider === 'grok' && target.protocol === 'grok-responses')) &&
      bounded(target.capability_capture_id) &&
      /^[a-f0-9]{64}$/u.test(String(target.capability_digest)),
  );
}

function validNative(value: unknown): boolean {
  if (value === null) return true;
  const native = record(value);
  return Boolean(
    native &&
      Object.keys(native).length === 3 &&
      bounded(native.process_instance_id) &&
      bounded(native.fx_build_revision) &&
      (native.session_id === null || bounded(native.session_id)),
  );
}

function validateReceipt(value: unknown): value is FxBrokerBindingReceipt {
  const receipt = record(value);
  const account = record(receipt?.account);
  return (
    Object.keys(receipt ?? {}).length === 19 &&
    receipt?.schema_version === 1 &&
    bounded(receipt.request_id) &&
    bounded(receipt.lease_id) &&
    bounded(receipt.binding_id) &&
    /^[a-f0-9]{64}$/u.test(String(receipt.binding_digest)) &&
    /^[a-f0-9]{64}$/u.test(String(receipt.authority_digest)) &&
    bounded(receipt.broker_incarnation) &&
    safeInteger(receipt.lease_revision, 1) &&
    ['prepared', 'active', 'expired', 'revoked', 'released'].includes(
      String(receipt.state),
    ) &&
    validOwner(receipt.owner) &&
    Boolean(
      account &&
        Object.keys(account).length === 4 &&
        (account.provider === 'codex' || account.provider === 'grok') &&
        new RegExp(`^${account.provider}-[1-9]\\d*$`, 'u').test(
          String(account.account_key),
        ) &&
        safeInteger(account.account_generation, 1) &&
        safeInteger(account.provider_generation, 1),
    ) &&
    validTarget(receipt.target) &&
    safeInteger(receipt.issued_at_ms) &&
    safeInteger(receipt.activate_before_ms) &&
    safeInteger(receipt.expires_at_ms) &&
    safeInteger(receipt.execution_deadline_ms) &&
    validNative(receipt.native) &&
    typeof receipt.activation_supported === 'boolean' &&
    (receipt.terminal_reason === null || bounded(receipt.terminal_reason, 128))
  );
}

function validateForwardReceipt(
  value: unknown,
  status: unknown,
  requestId: unknown,
  leaseId: unknown,
): boolean {
  const receipt = record(value);
  if (!receipt) return false;
  if (status === 'refused') {
    return Boolean(
      Object.keys(receipt).length === 8 &&
      receipt.schema_version === 1 &&
      receipt.request_id === requestId &&
      REFUSAL_CODES.has(String(receipt.code)) &&
      receipt.stage === 'pre_admission' &&
      receipt.disposition === 'refused' &&
      ['none', 'same_command', 'new_authorized_attempt'].includes(String(receipt.retry)) &&
      receipt.provider_delivery === 'not_forwarded' &&
      bounded(receipt.message, 256)
    );
  }
  if (Object.keys(receipt).length !== 7) return false;
  const applied = status === 'applied';
  return Boolean(
    receipt.schema_version === 1 &&
      receipt.request_id === requestId &&
      receipt.lease_id === leaseId &&
      bounded(receipt.binding_id) &&
      safeInteger(receipt.lease_revision, 1) &&
      receipt.disposition === (applied ? 'forwarded' : 'outcome_unknown') &&
      receipt.provider_delivery ===
        (applied ? 'forwarded' : 'may_have_forwarded'),
  );
}

function validate(value: unknown): FxBrokerState {
  const state = record(value);
  if (
    state?.schema_version !== 1 ||
    !safeInteger(state.broker_epoch) ||
    !bounded(state.broker_incarnation) ||
    !Array.isArray(state.leases) ||
    state.leases.length > 1024 ||
    !Array.isArray(state.operations) ||
    state.operations.length > 4096
  )
    throw new AccountError('invalid-state', 'Invalid Fx broker state');
  const leaseIds = new Set<string>();
  for (const raw of state.leases) {
    const lease = record(raw);
    const account = record(lease?.account);
    if (
      !lease ||
      !account ||
      !bounded(lease.lease_id) ||
      leaseIds.has(lease.lease_id as string) ||
      !bounded(lease.binding_id) ||
      !/^[a-f0-9]{64}$/u.test(String(lease.capability_hash)) ||
      !/^[a-f0-9]{64}$/u.test(String(lease.binding_digest)) ||
      !/^[a-f0-9]{64}$/u.test(String(lease.authority_digest)) ||
      !bounded(lease.broker_incarnation) ||
      !safeInteger(lease.lease_revision, 1) ||
      !['prepared', 'active', 'expired', 'revoked', 'released'].includes(
        String(lease.state),
      ) ||
      (account.provider !== 'codex' && account.provider !== 'grok') ||
      !new RegExp(`^${account.provider}-[1-9]\\d*$`, 'u').test(
        String(account.account_key),
      ) ||
      !safeInteger(account.account_generation, 1) ||
      !safeInteger(account.provider_generation, 1) ||
      !safeInteger(account.credential_revision, 1) ||
      !validOwner(lease.owner) ||
      !validTarget(lease.target) ||
      !safeInteger(lease.issued_at_ms) ||
      !safeInteger(lease.activate_before_ms) ||
      !safeInteger(lease.expires_at_ms) ||
      !safeInteger(lease.execution_deadline_ms) ||
      Number(lease.issued_at_ms) > Number(lease.activate_before_ms) ||
      (lease.state === 'prepared' &&
        Number(lease.activate_before_ms) > Number(lease.expires_at_ms)) ||
      Number(lease.expires_at_ms) > Number(lease.execution_deadline_ms) ||
      !validNative(lease.native) ||
      typeof lease.activation_supported !== 'boolean' ||
      !(
        lease.terminal_reason === null || bounded(lease.terminal_reason, 128)
      )
    )
      throw new AccountError('invalid-state', 'Invalid Fx broker lease');
    leaseIds.add(lease.lease_id as string);
  }
  const requestIds = new Set<string>();
  for (const raw of state.operations) {
    const operation = record(raw);
    if (
      !operation ||
      !bounded(operation.request_id) ||
      requestIds.has(operation.request_id as string) ||
      !/^[a-f0-9]{64}$/u.test(String(operation.request_digest)) ||
      !['prepare', 'activate', 'renew', 'release', 'revoke', 'forward'].includes(
        String(operation.kind),
      ) ||
      !bounded(operation.lease_id) ||
      !leaseIds.has(operation.lease_id as string) ||
      !['applied', 'refused', 'outcome_unknown'].includes(String(operation.status)) ||
      !record(operation.result)
    )
      throw new AccountError('invalid-state', 'Invalid Fx broker operation');
    if (
      operation.kind !== 'forward' &&
      operation.status === 'applied' &&
      (!validateReceipt(operation.result) ||
        operation.result.request_id !== operation.request_id ||
        operation.result.lease_id !== operation.lease_id)
    )
      throw new AccountError('invalid-state', 'Invalid Fx broker receipt');
    if (
      operation.kind === 'forward' &&
      !validateForwardReceipt(
        operation.result,
        operation.status,
        operation.request_id,
        operation.lease_id,
      )
    )
      throw new AccountError('invalid-state', 'Invalid Fx broker forward receipt');
    requestIds.add(operation.request_id as string);
  }
  return value as FxBrokerState;
}

export function readFxBrokerState(paths: StatePaths): FxBrokerState {
  checkPrivateDirectory(paths.stateRoot);
  return readPrivate(fxBrokerStateFile(paths), validate, emptyState);
}

export async function changeFxBrokerState<T>(
  paths: StatePaths,
  fn: (
    state: FxBrokerState,
    persist: () => void,
  ) => T | Promise<T>,
): Promise<T> {
  privateDirectory(paths.stateRoot);
  return withLock(fxBrokerLockFile(paths), async () => {
    const state = readFxBrokerState(paths);
    const persist = (): void => {
      validate(state);
      writePrivate(fxBrokerStateFile(paths), state);
    };
    const result = await fn(state, persist);
    validate(state);
    writePrivate(fxBrokerStateFile(paths), state);
    return result;
  });
}

export function publicFxBrokerReceipt(
  lease: DurableFxBrokerLease,
  requestId: string,
): FxBrokerBindingReceipt {
  return {
    schema_version: 1,
    request_id: requestId,
    lease_id: lease.lease_id,
    binding_id: lease.binding_id,
    binding_digest: lease.binding_digest,
    authority_digest: lease.authority_digest,
    broker_incarnation: lease.broker_incarnation,
    lease_revision: lease.lease_revision,
    state: lease.state,
    owner: structuredClone(lease.owner),
    account: {
      provider: lease.account.provider,
      account_key: lease.account.account_key,
      account_generation: lease.account.account_generation,
      provider_generation: lease.account.provider_generation,
    },
    target: structuredClone(lease.target),
    issued_at_ms: lease.issued_at_ms,
    activate_before_ms: lease.activate_before_ms,
    expires_at_ms: lease.expires_at_ms,
    execution_deadline_ms: lease.execution_deadline_ms,
    native: structuredClone(lease.native),
    activation_supported: lease.activation_supported,
    terminal_reason: lease.terminal_reason,
  };
}
