import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StatePaths } from '../paths.ts';
import { AccountError } from '../accounts/storage.ts';
import {
  changeFxBrokerState,
  type DurableFxBrokerLease,
  type DurableFxBrokerOperation,
  publicFxBrokerReceipt,
} from './store.ts';
import {
  type FxBrokerActivateCommand,
  type FxBrokerAuthority,
  type FxBrokerAuthorityAccount,
  type FxBrokerBindingReceipt,
  type FxBrokerForwardCommand,
  type FxBrokerForwardResult,
  type FxBrokerNativeBinding,
  type FxBrokerOwner,
  type FxBrokerPrepareCommand,
  type FxBrokerPrepareResult,
  type FxBrokerProvider,
  type FxBrokerRefusal,
  type FxBrokerReleaseCommand,
  type FxBrokerRenewCommand,
  type FxBrokerRevokeCommand,
  type FxBrokerTarget,
  FX_BROKER_SCHEMA_VERSION,
} from './types.ts';

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LEASES = 1024;
const MAX_OPERATIONS = 4096;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 5 * 60_000;
const ACTIVATE_WINDOW_MS = 30_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const tokenDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function fixedId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 256 ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw refusal('invalid', 'invalid_request', `Invalid ${label}`);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw refusal('invalid', 'invalid_request', `Invalid ${label}`);
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== [...expected].sort().join('\0'))
    throw refusal('invalid', 'invalid_request', `Invalid ${label}`);
}

function cleanOwner(owner: FxBrokerOwner): FxBrokerOwner {
  exactKeys(
    owner,
    [
      'host_id',
      'host_incarnation',
      'control_epoch',
      'execution_id',
      'attempt_id',
    ],
    'owner',
  );
  fixedId(owner.host_id, 'host_id');
  fixedId(owner.host_incarnation, 'host_incarnation');
  positiveInteger(owner.control_epoch, 'control_epoch');
  fixedId(owner.execution_id, 'execution_id');
  fixedId(owner.attempt_id, 'attempt_id');
  return structuredClone(owner);
}

function cleanTarget(target: FxBrokerTarget): FxBrokerTarget {
  exactKeys(
    target,
    [
      'target_id',
      'target_revision',
      'provider',
      'model',
      'effort',
      'service_tier',
      'protocol',
      'capability_capture_id',
      'capability_digest',
    ],
    'target',
  );
  fixedId(target.target_id, 'target_id');
  fixedId(target.target_revision, 'target_revision');
  if (target.provider !== 'codex' && target.provider !== 'grok')
    throw refusal('invalid', 'invalid_request', 'Invalid provider');
  fixedId(target.model, 'model');
  fixedId(target.effort, 'effort');
  if (target.service_tier !== null) fixedId(target.service_tier, 'service_tier');
  if (
    (target.provider === 'codex' && target.protocol !== 'openai-responses') ||
    (target.provider === 'grok' && target.protocol !== 'grok-responses')
  )
    throw refusal('invalid', 'target_mismatch', 'Provider protocol mismatch');
  fixedId(target.capability_capture_id, 'capability_capture_id');
  if (!/^[a-f0-9]{64}$/u.test(target.capability_digest))
    throw refusal('invalid', 'invalid_request', 'Invalid capability digest');
  return structuredClone(target);
}

function cleanNative(native: FxBrokerNativeBinding): FxBrokerNativeBinding {
  exactKeys(
    native,
    ['process_instance_id', 'fx_build_revision', 'session_id'],
    'native binding',
  );
  fixedId(native.process_instance_id, 'process_instance_id');
  fixedId(native.fx_build_revision, 'fx_build_revision');
  if (native.session_id !== null) fixedId(native.session_id, 'session_id');
  return structuredClone(native);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function assertBoundedCommand(value: unknown): void {
  if (Buffer.byteLength(canonical(value)) > MAX_COMMAND_BYTES)
    throw refusal('invalid', 'invalid_request', 'Broker command exceeds 16 KiB');
}

function refusal(
  requestId: string,
  code: FxBrokerRefusal['code'],
  message: string,
  options: Partial<
    Pick<FxBrokerRefusal, 'disposition' | 'retry' | 'provider_delivery'>
  > = {},
): FxBrokerError {
  return new FxBrokerError({
    schema_version: FX_BROKER_SCHEMA_VERSION,
    request_id: requestId,
    code,
    disposition: options.disposition ?? 'refused',
    retry: options.retry ?? 'new_authorized_attempt',
    provider_delivery: options.provider_delivery ?? 'not_forwarded',
    message,
  });
}

export class FxBrokerError extends AccountError {
  constructor(readonly receipt: FxBrokerRefusal) {
    super(receipt.code, receipt.message, 409);
  }
}

function operation(
  operations: DurableFxBrokerOperation[],
  requestId: string,
  requestDigest: string,
): DurableFxBrokerOperation | null {
  const found = operations.find((entry) => entry.request_id === requestId);
  if (!found) return null;
  if (found.request_digest !== requestDigest)
    throw refusal(
      requestId,
      'idempotency_conflict',
      'Request ID is bound to different input',
      { retry: 'none' },
    );
  return found;
}

function assertBroker(
  requestId: string,
  expected: string,
  actual: string,
  executing: string,
): void {
  if (executing !== actual)
    throw refusal(requestId, 'broker_unavailable', 'Broker instance is fenced');
  if (expected !== actual)
    throw refusal(requestId, 'stale_fence', 'Broker incarnation is stale');
}

function assertToken(
  requestId: string,
  lease: DurableFxBrokerLease,
  token: string,
): void {
  fixedId(token, 'capability token');
  const supplied = Buffer.from(tokenDigest(token), 'hex');
  const expected = Buffer.from(lease.capability_hash, 'hex');
  if (
    supplied.byteLength !== expected.byteLength ||
    !timingSafeEqual(supplied, expected)
  )
    throw refusal(requestId, 'stale_fence', 'Capability is invalid');
}

function assertOwner(
  requestId: string,
  lease: DurableFxBrokerLease,
  owner: FxBrokerOwner,
): void {
  const cleaned = cleanOwner(owner);
  if (!same(cleaned, lease.owner))
    throw refusal(requestId, 'stale_fence', 'Lease owner fence is stale');
}

function assertRevision(
  requestId: string,
  lease: DurableFxBrokerLease,
  expected: number,
): void {
  positiveInteger(expected, 'lease revision');
  if (lease.lease_revision !== expected)
    throw refusal(requestId, 'stale_fence', 'Lease revision is stale');
}

function expire(state: { leases: DurableFxBrokerLease[] }, now: number): boolean {
  let changed = false;
  for (const lease of state.leases) {
    if (
      (lease.state === 'prepared' || lease.state === 'active') &&
      (now >= lease.expires_at_ms ||
        now >= lease.execution_deadline_ms ||
        (lease.state === 'prepared' && now >= lease.activate_before_ms))
    ) {
      lease.state = 'expired';
      lease.lease_revision += 1;
      lease.terminal_reason = 'lease_expired';
      changed = true;
    }
  }
  return changed;
}

function currentLease(
  leases: DurableFxBrokerLease[],
  requestId: string,
  leaseId: string,
): DurableFxBrokerLease {
  fixedId(leaseId, 'lease_id');
  const lease = leases.find((entry) => entry.lease_id === leaseId);
  if (!lease)
    throw refusal(requestId, 'identity_unavailable', 'Lease does not exist');
  return lease;
}

function checkAccount(
  requestId: string,
  authority: FxBrokerAuthorityAccount,
  lease: DurableFxBrokerLease,
): void {
  if (
    authority.provider !== lease.account.provider ||
    authority.account_key !== lease.account.account_key ||
    authority.account_generation !== lease.account.account_generation ||
    authority.provider_generation !== lease.account.provider_generation
  )
    throw refusal(
      requestId,
      'generation_mismatch',
      'Pinned provider or account generation changed',
      { retry: 'none' },
    );
  if (!authority.enabled || !authority.auth_available)
    throw refusal(requestId, 'auth_unavailable', 'Account authorization unavailable');
  if (!authority.activation_supported)
    throw refusal(requestId, 'adapter_unsupported', 'Fx adapter is unavailable');
  if (authority.credential_revision < lease.account.credential_revision)
    throw refusal(
      requestId,
      'capability_stale',
      'Credential authority revision regressed',
      { retry: 'none' },
    );
  if (!same(authority.target, lease.target))
    throw refusal(requestId, 'capability_stale', 'Pinned target capability changed');
}

function safeAuthorityDigest(account: FxBrokerAuthorityAccount): string {
  return digest({
    provider: account.provider,
    account_key: account.account_key,
    account_generation: account.account_generation,
    provider_generation: account.provider_generation,
    target: account.target,
  });
}

export class FxCredentialBroker {
  private constructor(
    private readonly paths: StatePaths,
    private readonly authority: FxBrokerAuthority,
    readonly incarnation: string,
    private readonly clock: () => number,
  ) {}

  static async open(
    paths: StatePaths,
    authority: FxBrokerAuthority,
    options: { clock?: () => number } = {},
  ): Promise<FxCredentialBroker> {
    const incarnation = `fxb_${randomBytes(18).toString('base64url')}`;
    const clock = options.clock ?? Date.now;
    await changeFxBrokerState(paths, (state) => {
      state.broker_epoch += 1;
      state.broker_incarnation = incarnation;
      for (const lease of state.leases) {
        if (lease.state === 'prepared' || lease.state === 'active') {
          lease.state = 'revoked';
          lease.lease_revision += 1;
          lease.terminal_reason = 'broker_restarted';
        }
      }
      for (const pending of state.operations) {
        if (pending.status === 'outcome_unknown' && pending.kind === 'forward') {
          pending.result = {
            ...pending.result,
            disposition: 'outcome_unknown',
            provider_delivery: 'may_have_forwarded',
          };
        }
      }
    });
    return new FxCredentialBroker(paths, authority, incarnation, clock);
  }

  async prepare(command: FxBrokerPrepareCommand): Promise<FxBrokerPrepareResult> {
    assertBoundedCommand(command);
    exactKeys(
      command,
      [
        'schema_version',
        'request_id',
        'expected_broker_incarnation',
        'owner',
        'target',
        'account',
        'consumer_nonce',
        'requested_ttl_ms',
        'execution_deadline_ms',
      ],
      'prepare command',
    );
    if (command.schema_version !== 1)
      throw refusal('invalid', 'invalid_request', 'Unsupported broker schema');
    fixedId(command.request_id, 'request_id');
    fixedId(command.expected_broker_incarnation, 'broker incarnation');
    const owner = cleanOwner(command.owner);
    const target = cleanTarget(command.target);
    exactKeys(
      command.account,
      ['account_key', 'expected_account_generation', 'expected_provider_generation'],
      'account pin',
    );
    if (!new RegExp(`^${target.provider}-[1-9]\\d*$`, 'u').test(command.account.account_key))
      throw refusal(command.request_id, 'target_mismatch', 'Account provider mismatch');
    positiveInteger(
      command.account.expected_account_generation,
      'account generation',
    );
    positiveInteger(
      command.account.expected_provider_generation,
      'provider generation',
    );
    if (!/^[A-Za-z0-9_-]{43}$/u.test(command.consumer_nonce))
      throw refusal(command.request_id, 'invalid_request', 'Invalid consumer nonce');
    if (
      !Number.isSafeInteger(command.requested_ttl_ms) ||
      command.requested_ttl_ms < MIN_TTL_MS ||
      command.requested_ttl_ms > MAX_TTL_MS
    )
      throw refusal(command.request_id, 'invalid_request', 'Invalid lease TTL');
    positiveInteger(command.execution_deadline_ms, 'execution deadline');
    command = {
      ...command,
      owner,
      target,
      account: { ...command.account },
    };
    // The expected broker incarnation is a transport fence, not part of the
    // semantic command. Keeping it out of the digest lets a caller recover a
    // durable receipt after a broker restart without authorizing a new effect.
    const {
      expected_broker_incarnation: _transportFence,
      ...semanticCommand
    } = command;
    const normalized = { ...semanticCommand, owner, target };
    const requestDigest = digest(normalized);
    return changeFxBrokerState(this.paths, async (state, persist) => {
      const now = this.clock();
      assertBroker(
        command.request_id,
        command.expected_broker_incarnation,
        state.broker_incarnation,
        this.incarnation,
      );
      if (expire(state, now)) persist();
      const existing = operation(state.operations, command.request_id, requestDigest);
      if (existing) {
        const lease = currentLease(
          state.leases,
          command.request_id,
          existing.lease_id,
        );
        const token = `${lease.lease_id}.${command.consumer_nonce}`;
        const handoff =
          lease.broker_incarnation === this.incarnation &&
          (lease.state === 'prepared' || lease.state === 'active') &&
          tokenDigest(token) === lease.capability_hash
            ? {
                schema_version: FX_BROKER_SCHEMA_VERSION,
                lease_id: lease.lease_id,
                broker_incarnation: lease.broker_incarnation,
                capability_token: token,
                activate_before_ms: lease.activate_before_ms,
              }
            : null;
        return {
          receipt: structuredClone(
            existing.result,
          ) as unknown as FxBrokerBindingReceipt,
          handoff,
          replayed: true,
        };
      }
      if (state.leases.length >= MAX_LEASES || state.operations.length >= MAX_OPERATIONS)
        throw refusal(command.request_id, 'capacity_unavailable', 'Broker state capacity reached');
      if (command.execution_deadline_ms <= now)
        throw refusal(command.request_id, 'expired', 'Execution deadline has passed');
      const account = await this.inspectAuthority(
        command.request_id,
        target.provider,
        command.account.account_key,
      );
      if (
        account.account_generation !== command.account.expected_account_generation ||
        account.provider_generation !== command.account.expected_provider_generation
      )
        throw refusal(
          command.request_id,
          'generation_mismatch',
          'Expected provider or account generation is stale',
          { retry: 'none' },
        );
      if (!account.enabled || !account.auth_available)
        throw refusal(command.request_id, 'auth_unavailable', 'Account authorization unavailable');
      if (!same(account.target, target))
        throw refusal(command.request_id, 'target_mismatch', 'Target capability mismatch');
      if (!account.activation_supported)
        throw refusal(command.request_id, 'adapter_unsupported', 'Fx adapter is unavailable');
      if (
        state.leases.some(
          (lease) =>
            lease.account.provider === target.provider &&
            lease.account.account_key === account.account_key &&
            (lease.state === 'prepared' || lease.state === 'active'),
        )
      )
        throw refusal(command.request_id, 'capacity_unavailable', 'Account already has an active Fx lease');
      const expires = Math.min(now + command.requested_ttl_ms, command.execution_deadline_ms);
      const leaseId = randomUUID();
      const bindingId = `bind_${randomBytes(18).toString('base64url')}`;
      const token = `${leaseId}.${command.consumer_nonce}`;
      const safeAccount = {
        provider: account.provider,
        account_key: account.account_key,
        account_generation: account.account_generation,
        provider_generation: account.provider_generation,
      };
      const authorityDigest = safeAuthorityDigest(account);
      const lease: DurableFxBrokerLease = {
        lease_id: leaseId,
        binding_id: bindingId,
        capability_hash: tokenDigest(token),
        binding_digest: digest({
          broker_incarnation: this.incarnation,
          binding_id: bindingId,
          owner,
          account: safeAccount,
          target,
        }),
        authority_digest: authorityDigest,
        broker_incarnation: this.incarnation,
        lease_revision: 1,
        state: 'prepared',
        owner,
        account: { ...safeAccount, credential_revision: account.credential_revision },
        target,
        issued_at_ms: now,
        activate_before_ms: Math.min(now + ACTIVATE_WINDOW_MS, expires),
        expires_at_ms: expires,
        execution_deadline_ms: command.execution_deadline_ms,
        native: null,
        activation_supported: true,
        terminal_reason: null,
      };
      state.leases.push(lease);
      const receipt = publicFxBrokerReceipt(lease, command.request_id);
      state.operations.push({
        request_id: command.request_id,
        request_digest: requestDigest,
        kind: 'prepare',
        lease_id: leaseId,
        status: 'applied',
        result: structuredClone(receipt) as unknown as Record<string, unknown>,
      });
      return {
        receipt,
        handoff: {
          schema_version: FX_BROKER_SCHEMA_VERSION,
          lease_id: leaseId,
          broker_incarnation: this.incarnation,
          capability_token: token,
          activate_before_ms: lease.activate_before_ms,
        },
        replayed: false,
      };
    });
  }

  async activate(command: FxBrokerActivateCommand): Promise<FxBrokerBindingReceipt> {
    return this.changeLease('activate', command, async (lease, recheckExpiry, snapshot) => {
      if (lease.state !== 'prepared')
        throw refusal(snapshot.request_id, lease.state === 'expired' ? 'expired' : 'stale_fence', 'Lease is not prepared');
      const native = cleanNative((snapshot as FxBrokerActivateCommand).native);
      const account = await this.inspectAuthority(
        snapshot.request_id,
        lease.account.provider,
        lease.account.account_key,
      );
      recheckExpiry();
      checkAccount(snapshot.request_id, account, lease);
      lease.account.credential_revision = account.credential_revision;
      lease.native = native;
      lease.state = 'active';
      lease.lease_revision += 1;
    });
  }

  async renew(command: FxBrokerRenewCommand): Promise<FxBrokerBindingReceipt> {
    if (
      !Number.isSafeInteger(command.requested_ttl_ms) ||
      command.requested_ttl_ms < MIN_TTL_MS ||
      command.requested_ttl_ms > MAX_TTL_MS
    )
      throw refusal(command.request_id, 'invalid_request', 'Invalid lease TTL');
    return this.changeLease('renew', command, async (lease, recheckExpiry, snapshot) => {
      if (lease.state !== 'prepared' && lease.state !== 'active')
        throw refusal(snapshot.request_id, lease.state as 'expired' | 'revoked' | 'released', 'Lease is terminal');
      const account = await this.inspectAuthority(
        snapshot.request_id,
        lease.account.provider,
        lease.account.account_key,
      );
      recheckExpiry();
      checkAccount(snapshot.request_id, account, lease);
      lease.account.credential_revision = account.credential_revision;
      lease.expires_at_ms = Math.min(
        this.clock() + (snapshot as FxBrokerRenewCommand).requested_ttl_ms,
        lease.execution_deadline_ms,
      );
      if (lease.state === 'prepared')
        lease.activate_before_ms = Math.min(
          lease.activate_before_ms,
          lease.expires_at_ms,
        );
      lease.lease_revision += 1;
    });
  }

  async release(command: FxBrokerReleaseCommand): Promise<FxBrokerBindingReceipt> {
    return this.changeLease('release', command, async (lease) => {
      if (lease.state === 'prepared' || lease.state === 'active') {
        lease.state = 'released';
        lease.lease_revision += 1;
        lease.terminal_reason = 'consumer_released';
      }
    });
  }

  async revoke(command: FxBrokerRevokeCommand): Promise<FxBrokerBindingReceipt> {
    assertBoundedCommand(command);
    exactKeys(
      command,
      [
        'schema_version',
        'request_id',
        'expected_broker_incarnation',
        'lease_id',
        'reason',
      ],
      'revoke command',
    );
    if (command.schema_version !== FX_BROKER_SCHEMA_VERSION)
      throw refusal('invalid', 'invalid_request', 'Unsupported broker schema');
    fixedId(command.request_id, 'request_id');
    fixedId(command.expected_broker_incarnation, 'broker incarnation');
    if (!['account_disabled', 'auth_invalidated', 'operator', 'broker_policy'].includes(command.reason))
      throw refusal(command.request_id, 'invalid_request', 'Invalid revocation reason');
    command = { ...command };
    const requestDigest = digest(command);
    return changeFxBrokerState(this.paths, (state, persist) => {
      assertBroker(
        command.request_id,
        command.expected_broker_incarnation,
        state.broker_incarnation,
        this.incarnation,
      );
      if (expire(state, this.clock())) persist();
      const existing = operation(state.operations, command.request_id, requestDigest);
      if (existing)
        return structuredClone(
          existing.result,
        ) as unknown as FxBrokerBindingReceipt;
      const lease = currentLease(state.leases, command.request_id, command.lease_id);
      if (lease.state === 'prepared' || lease.state === 'active') {
        lease.state = 'revoked';
        lease.lease_revision += 1;
        lease.terminal_reason = command.reason;
      }
      const receipt = publicFxBrokerReceipt(lease, command.request_id);
      state.operations.push({
        request_id: command.request_id,
        request_digest: requestDigest,
        kind: 'revoke',
        lease_id: lease.lease_id,
        status: 'applied',
        result: structuredClone(receipt) as unknown as Record<string, unknown>,
      });
      return receipt;
    });
  }

  async get(leaseId: string, requestId = 'get'): Promise<FxBrokerBindingReceipt> {
    fixedId(requestId, 'request_id');
    return changeFxBrokerState(this.paths, (state, persist) => {
      if (state.broker_incarnation !== this.incarnation)
        throw refusal(requestId, 'broker_unavailable', 'Broker instance is fenced');
      if (expire(state, this.clock())) persist();
      return publicFxBrokerReceipt(
        currentLease(state.leases, requestId, leaseId),
        requestId,
      );
    });
  }

  async forward(command: FxBrokerForwardCommand): Promise<FxBrokerForwardResult> {
    exactKeys(
      command,
      [
        'schema_version',
        'request_id',
        'expected_broker_incarnation',
        'lease_id',
        'capability_token',
        'expected_lease_revision',
        'owner',
        'native',
        'target',
        'operation',
        'body',
        'headers',
      ],
      'forward command',
    );
    if (command.schema_version !== FX_BROKER_SCHEMA_VERSION)
      throw refusal('invalid', 'invalid_request', 'Unsupported broker schema');
    fixedId(command.request_id, 'request_id');
    fixedId(command.expected_broker_incarnation, 'broker incarnation');
    if (command.operation !== 'catalog' && command.operation !== 'inference')
      throw refusal(command.request_id, 'invalid_request', 'Invalid broker operation');
    if (command.body.byteLength > MAX_BODY_BYTES)
      throw refusal(command.request_id, 'invalid_request', 'Provider body exceeds 1 MiB');
    // Buffer#slice is a view, so construct a Uint8Array to own the bytes. The
    // caller may mutate its buffer while authority inspection is awaited; both
    // the digest and admission use this snapshot.
    const body = Uint8Array.from(command.body);
    const target = cleanTarget(command.target);
    const owner = cleanOwner(command.owner);
    const native = cleanNative(command.native);
    const headers = this.cleanHeaders(command.request_id, command.headers);
    command = {
      ...command,
      target,
      owner,
      native,
      headers,
      body,
    };
    const {
      expected_broker_incarnation: _transportFence,
      ...semanticCommand
    } = command;
    const digestInput = {
      ...semanticCommand,
      body: {
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
      headers,
      target,
      owner,
      native,
    };
    assertBoundedCommand(digestInput);
    const requestDigest = digest(digestInput);
    return changeFxBrokerState(this.paths, async (state, persist) => {
      assertBroker(
        command.request_id,
        command.expected_broker_incarnation,
        state.broker_incarnation,
        this.incarnation,
      );
      if (expire(state, this.clock())) persist();
      const existing = operation(state.operations, command.request_id, requestDigest);
      if (existing) {
        return {
          receipt: existing.result as unknown as FxBrokerForwardResult['receipt'],
          response: null,
          replayed: true,
        };
      }
      if (state.operations.length >= MAX_OPERATIONS)
        throw refusal(command.request_id, 'capacity_unavailable', 'Broker operation capacity reached');
      const lease = currentLease(state.leases, command.request_id, command.lease_id);
      assertToken(command.request_id, lease, command.capability_token);
      assertRevision(command.request_id, lease, command.expected_lease_revision);
      assertOwner(command.request_id, lease, owner);
      if (lease.state !== 'active')
        throw refusal(command.request_id, lease.state as 'expired' | 'revoked' | 'released', 'Lease is not active');
      if (!same(native, lease.native))
        throw refusal(command.request_id, 'stale_fence', 'Native process or session fence is stale');
      if (!same(target, lease.target))
        throw refusal(command.request_id, 'target_mismatch', 'Forward target differs from lease');
      const account = await this.inspectAuthority(
        command.request_id,
        lease.account.provider,
        lease.account.account_key,
      );
      if (expire(state, this.clock())) persist();
      if ((lease as DurableFxBrokerLease).state === 'expired')
        throw refusal(command.request_id, 'expired', 'Lease expired before provider admission');
      checkAccount(command.request_id, account, lease);
      const uncertainReceipt: FxBrokerForwardResult['receipt'] = {
        schema_version: FX_BROKER_SCHEMA_VERSION,
        request_id: command.request_id,
        lease_id: lease.lease_id,
        binding_id: lease.binding_id,
        lease_revision: lease.lease_revision,
        disposition: 'outcome_unknown',
        provider_delivery: 'may_have_forwarded',
      };
      const durable: DurableFxBrokerOperation = {
        request_id: command.request_id,
        request_digest: requestDigest,
        kind: 'forward',
        lease_id: lease.lease_id,
        status: 'outcome_unknown',
        result: structuredClone(uncertainReceipt) as unknown as Record<string, unknown>,
      };
      state.operations.push(durable);
      persist();
      let forwarded;
      try {
        forwarded = await this.authority.forward(account, {
          operation: command.operation,
          target,
          body: body.slice(),
          headers,
        });
      } catch {
        throw refusal(
          command.request_id,
          'refresh_outcome_unknown',
          'Broker request outcome is unknown',
          {
            disposition: 'outcome_unknown',
            retry: 'same_command',
            provider_delivery: 'may_have_forwarded',
          },
        );
      }
      if (
        forwarded.account_generation !== lease.account.account_generation ||
        forwarded.provider_generation !== lease.account.provider_generation
      )
        throw refusal(
          command.request_id,
          'generation_mismatch',
          'Authority generation changed during forwarding',
          {
            disposition: 'outcome_unknown',
            retry: 'none',
            provider_delivery: 'may_have_forwarded',
          },
        );
      if (
        !Number.isSafeInteger(forwarded.credential_revision) ||
        forwarded.credential_revision < lease.account.credential_revision
      )
        throw refusal(
          command.request_id,
          'refresh_outcome_unknown',
          'Credential revision is not authoritative',
          {
            disposition: 'outcome_unknown',
            retry: 'none',
            provider_delivery: 'may_have_forwarded',
          },
        );
      const response = this.validateResponse(
        command.request_id,
        forwarded.response,
      );
      lease.account.credential_revision = forwarded.credential_revision;
      const appliedReceipt: FxBrokerForwardResult['receipt'] = {
        ...uncertainReceipt,
        disposition: 'forwarded',
        provider_delivery: 'forwarded',
      };
      durable.status = 'applied';
      durable.result = structuredClone(appliedReceipt) as unknown as Record<string, unknown>;
      return {
        receipt: appliedReceipt,
        response: {
          status: response.status,
          headers: response.headers,
          body: response.body,
        },
        replayed: false,
      };
    });
  }

  private async changeLease(
    kind: 'activate' | 'renew' | 'release',
    command:
      | FxBrokerActivateCommand
      | FxBrokerRenewCommand
      | FxBrokerReleaseCommand,
    mutate: (
      lease: DurableFxBrokerLease,
      recheckExpiry: () => void,
      command:
        | FxBrokerActivateCommand
        | FxBrokerRenewCommand
        | FxBrokerReleaseCommand,
    ) => Promise<void>,
  ): Promise<FxBrokerBindingReceipt> {
    assertBoundedCommand(command);
    if (command.schema_version !== FX_BROKER_SCHEMA_VERSION)
      throw refusal('invalid', 'invalid_request', 'Unsupported broker schema');
    exactKeys(
      command,
      kind === 'activate'
        ? [
            'schema_version',
            'request_id',
            'expected_broker_incarnation',
            'lease_id',
            'capability_token',
            'expected_lease_revision',
            'owner',
            'native',
          ]
        : kind === 'renew'
          ? [
              'schema_version',
              'request_id',
              'expected_broker_incarnation',
              'lease_id',
              'capability_token',
              'expected_lease_revision',
              'owner',
              'requested_ttl_ms',
            ]
          : [
              'schema_version',
              'request_id',
              'expected_broker_incarnation',
              'lease_id',
              'capability_token',
              'expected_lease_revision',
              'owner',
            ],
      `${kind} command`,
    );
    fixedId(command.request_id, 'request_id');
    fixedId(command.expected_broker_incarnation, 'broker incarnation');
    const owner = cleanOwner(command.owner);
    command =
      kind === 'activate'
        ? {
            ...command,
            owner,
            native: cleanNative((command as FxBrokerActivateCommand).native),
          }
        : { ...command, owner };
    const requestDigest = digest({ ...command, owner });
    return changeFxBrokerState(this.paths, async (state, persist) => {
      assertBroker(
        command.request_id,
        command.expected_broker_incarnation,
        state.broker_incarnation,
        this.incarnation,
      );
      if (expire(state, this.clock())) persist();
      const existing = operation(state.operations, command.request_id, requestDigest);
      if (existing)
        return structuredClone(
          existing.result,
        ) as unknown as FxBrokerBindingReceipt;
      if (state.operations.length >= MAX_OPERATIONS)
        throw refusal(command.request_id, 'capacity_unavailable', 'Broker operation capacity reached');
      const lease = currentLease(state.leases, command.request_id, command.lease_id);
      assertToken(command.request_id, lease, command.capability_token);
      assertOwner(command.request_id, lease, owner);
      if (lease.state === 'expired')
        throw refusal(command.request_id, 'expired', 'Lease has expired');
      assertRevision(command.request_id, lease, command.expected_lease_revision);
      const recheckExpiry = (): void => {
        if (expire(state, this.clock())) persist();
        if (lease.state === 'expired')
          throw refusal(command.request_id, 'expired', 'Lease expired during authorization');
      };
      await mutate(lease, recheckExpiry, command);
      const receipt = publicFxBrokerReceipt(lease, command.request_id);
      state.operations.push({
        request_id: command.request_id,
        request_digest: requestDigest,
        kind,
        lease_id: lease.lease_id,
        status: 'applied',
        result: structuredClone(receipt) as unknown as Record<string, unknown>,
      });
      return receipt;
    });
  }

  private cleanHeaders(
    requestId: string,
    headers: Record<string, string>,
  ): Record<string, string> {
    if (Object.keys(headers).length > 32)
      throw refusal(requestId, 'invalid_request', 'Too many provider headers');
    const result: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(headers)) {
      const name = rawName.toLowerCase();
      if (
        !['accept', 'content-type'].includes(name) ||
        typeof value !== 'string' ||
        Buffer.byteLength(value) > 1024 ||
        /[\r\n]/u.test(value) ||
        Object.hasOwn(result, name)
      )
        throw refusal(requestId, 'invalid_request', 'Unsafe provider header');
      result[name] = value;
    }
    return result;
  }

  private async inspectAuthority(
    requestId: string,
    provider: FxBrokerProvider,
    accountKey: string,
  ): Promise<FxBrokerAuthorityAccount> {
    try {
      const account = await this.authority.inspect(provider, accountKey);
      exactKeys(
        account,
        [
          'provider',
          'account_key',
          'account_generation',
          'provider_generation',
          'credential_revision',
          'enabled',
          'auth_available',
          'target',
          'activation_supported',
        ],
        'authority account',
      );
      if (
        account.provider !== provider ||
        account.account_key !== accountKey ||
        !new RegExp(`^${provider}-[1-9]\\d*$`, 'u').test(account.account_key)
      )
        throw new Error('authority identity mismatch');
      positiveInteger(account.account_generation, 'account generation');
      positiveInteger(account.provider_generation, 'provider generation');
      positiveInteger(account.credential_revision, 'credential revision');
      if (
        typeof account.enabled !== 'boolean' ||
        typeof account.auth_available !== 'boolean' ||
        typeof account.activation_supported !== 'boolean'
      )
        throw new Error('authority flags invalid');
      const target = cleanTarget(account.target);
      if (target.provider !== provider)
        throw new Error('authority target mismatch');
      return { ...structuredClone(account), target };
    } catch {
      throw refusal(
        requestId,
        'identity_unavailable',
        'Account authority is unavailable',
      );
    }
  }

  private validateResponse(
    requestId: string,
    response: { status: number; headers: Record<string, string>; body: Uint8Array },
  ): { status: number; headers: Record<string, string>; body: Uint8Array } {
    if (
      !Number.isInteger(response.status) ||
      response.status < 100 ||
      response.status > 599 ||
      response.body.byteLength > MAX_RESPONSE_BYTES ||
      Object.keys(response.headers).length > 32
    )
      throw refusal(
        requestId,
        'refresh_outcome_unknown',
        'Broker response is invalid or oversized',
        {
          disposition: 'outcome_unknown',
          retry: 'none',
          provider_delivery: 'may_have_forwarded',
        },
      );
    const headers: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(response.headers)) {
      const name = rawName.toLowerCase();
      if (
        !['content-type', 'retry-after'].includes(name) ||
        typeof value !== 'string' ||
        Buffer.byteLength(value) > 1024 ||
        /[\r\n]/u.test(value)
      )
        continue;
      headers[name] = value;
    }
    return {
      status: response.status,
      headers,
      body: Uint8Array.from(response.body),
    };
  }
}
