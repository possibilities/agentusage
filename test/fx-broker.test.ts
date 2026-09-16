import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  FxBrokerError,
  FxCredentialBroker,
  type FxBrokerAuthority,
  type FxBrokerAuthorityAccount,
  type FxBrokerAuthorityForwardResult,
  type FxBrokerForwardCommand,
  type FxBrokerOwner,
  type FxBrokerPrepareCommand,
  type FxBrokerProvider,
  type FxBrokerRenewCommand,
  type FxBrokerTarget,
} from '../src/fx-broker/index.ts';
import { fxBrokerStateFile } from '../src/fx-broker/store.ts';
import { fixtureState } from './managed-fixtures.ts';

const sha = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function target(
  provider: FxBrokerProvider,
  model = provider === 'codex' ? 'gpt-test' : 'grok-test',
): FxBrokerTarget {
  return {
    target_id: `${provider}-${model}`,
    target_revision: `${provider}-target-r1`,
    provider,
    model,
    effort: 'medium',
    service_tier: null,
    protocol: provider === 'codex' ? 'openai-responses' : 'grok-responses',
    capability_capture_id: `${provider}-capture-1`,
    capability_digest: sha(`${provider}:${model}:capabilities`),
  };
}

const owner: FxBrokerOwner = {
  host_id: 'agentfx-test-host',
  host_incarnation: 'host-instance-1',
  control_epoch: 1,
  execution_id: 'exec-test-1',
  attempt_id: 'attempt-test-1',
};

type FakeAccount = FxBrokerAuthorityAccount & {
  secret: string;
  refresh_secret: string;
  refresh_next: boolean;
};

class FakeAuthority implements FxBrokerAuthority {
  readonly accounts = new Map<string, FakeAccount>();
  forwards = 0;
  refreshes = 0;
  failNext = false;
  inspectError: Error | null = null;
  inspectOverride: FxBrokerAuthorityAccount | null = null;
  inspectDelayMs = 0;
  inspectHook: (() => void) | null = null;
  responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
  activeForwards = 0;
  maxActiveForwards = 0;
  forwardedBodies: string[] = [];
  forwardedOperations: Array<'catalog' | 'inference'> = [];

  constructor() {
    for (const provider of ['codex', 'grok'] as const) {
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        const key = `${provider}-${ordinal}`;
        this.accounts.set(key, {
          provider,
          account_key: key,
          account_generation: 1,
          provider_generation: 1,
          credential_revision: 1,
          enabled: true,
          auth_available: true,
          target: target(provider),
          activation_supported: true,
          secret: `ACCESS_SECRET_${provider.toUpperCase()}_${ordinal}`,
          refresh_secret: `REFRESH_SECRET_${provider.toUpperCase()}_${ordinal}`,
          refresh_next: false,
        });
      }
    }
  }

  async inspect(
    provider: FxBrokerProvider,
    accountKey: string,
  ): Promise<FxBrokerAuthorityAccount> {
    if (this.inspectError) throw this.inspectError;
    this.inspectHook?.();
    if (this.inspectDelayMs) await Bun.sleep(this.inspectDelayMs);
    if (this.inspectOverride) return structuredClone(this.inspectOverride);
    const account = this.accounts.get(accountKey);
    if (!account || account.provider !== provider) throw new Error('missing fake account');
    const { secret: _secret, refresh_secret: _refresh, refresh_next: _next, ...view } =
      account;
    return structuredClone(view);
  }

  async forward(
    inspected: FxBrokerAuthorityAccount,
    request: Parameters<FxBrokerAuthority['forward']>[1],
  ): Promise<FxBrokerAuthorityForwardResult> {
    const account = this.accounts.get(inspected.account_key);
    if (!account) throw new Error('missing fake account');
    this.forwards += 1;
    this.activeForwards += 1;
    this.maxActiveForwards = Math.max(this.maxActiveForwards, this.activeForwards);
    this.forwardedBodies.push(Buffer.from(request.body).toString());
    this.forwardedOperations.push(request.operation);
    try {
      if (this.failNext) {
        this.failNext = false;
        throw new Error(`lost response ${account.secret}`);
      }
      const refresh = account.refresh_next;
      if (refresh) await Bun.sleep(10);
      if (refresh) {
        account.refresh_next = false;
        account.credential_revision += 1;
        account.secret = `ROTATED_SECRET_${account.account_key}_${account.credential_revision}`;
        this.refreshes += 1;
      }
      expect(JSON.stringify(request)).not.toContain(account.secret);
      expect(JSON.stringify(request)).not.toContain(account.refresh_secret);
      return {
        account_generation: account.account_generation,
        provider_generation: account.provider_generation,
        credential_revision: account.credential_revision,
        response: {
          status: 200,
          headers: structuredClone(this.responseHeaders),
          body: Buffer.from(
            JSON.stringify({
              provider: account.provider,
              account_key: account.account_key,
              operation: request.operation,
            }),
          ),
        },
      };
    } finally {
      this.activeForwards -= 1;
    }
  }
}

function nonce() {
  return randomBytes(32).toString('base64url');
}

function prepareCommand(
  broker: FxCredentialBroker,
  provider: FxBrokerProvider,
  accountKey: string,
  requestId: string,
  now: number,
  overrides: Partial<FxBrokerPrepareCommand> = {},
): FxBrokerPrepareCommand {
  return {
    schema_version: 1,
    request_id: requestId,
    expected_broker_incarnation: broker.incarnation,
    owner,
    target: target(provider),
    account: {
      account_key: accountKey,
      expected_account_generation: 1,
      expected_provider_generation: 1,
    },
    consumer_nonce: nonce(),
    requested_ttl_ms: 60_000,
    execution_deadline_ms: now + 5 * 60_000,
    ...overrides,
  };
}

async function activeLease(
  broker: FxCredentialBroker,
  provider: FxBrokerProvider,
  accountKey: string,
  requestId: string,
  now: number,
) {
  const command = prepareCommand(broker, provider, accountKey, requestId, now);
  const prepared = await broker.prepare(command);
  const handoff = prepared.handoff!;
  const native = {
    process_instance_id: `process-${requestId}`,
    fx_build_revision: 'fake-fx-build-1',
    session_id: `session-${requestId}`,
  };
  const activated = await broker.activate({
    schema_version: 1,
    request_id: `${requestId}-activate`,
    expected_broker_incarnation: broker.incarnation,
    lease_id: prepared.receipt.lease_id,
    capability_token: handoff.capability_token,
    expected_lease_revision: prepared.receipt.lease_revision,
    owner,
    native,
  });
  return { command, prepared, handoff, native, activated };
}

function forwardCommand(
  broker: FxCredentialBroker,
  lease: Awaited<ReturnType<typeof activeLease>>,
  requestId: string,
): FxBrokerForwardCommand {
  return {
    schema_version: 1,
    request_id: requestId,
    expected_broker_incarnation: broker.incarnation,
    lease_id: lease.activated.lease_id,
    capability_token: lease.handoff.capability_token,
    expected_lease_revision: lease.activated.lease_revision,
    owner,
    native: lease.native,
    target: lease.activated.target,
    operation: 'inference',
    body: Buffer.from('{"input":"synthetic only"}'),
    headers: { 'content-type': 'application/json' },
  };
}

function refusalCode(error: unknown): string | undefined {
  return error instanceof FxBrokerError ? error.receipt.code : undefined;
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
  check?: (error: FxBrokerError) => void,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code} refusal`);
  } catch (error) {
    expect(error).toBeInstanceOf(FxBrokerError);
    expect(refusalCode(error)).toBe(code);
    if (error instanceof FxBrokerError) check?.(error);
  }
}

describe('Fx credential broker', () => {
  test('binds two Codex and two Grok accounts without persisting or returning secrets', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    let now = 1_800_000_000_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    for (const provider of ['codex', 'grok'] as const) {
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        const accountKey = `${provider}-${ordinal}`;
        const lease = await activeLease(
          broker,
          provider,
          accountKey,
          `${provider}-${ordinal}`,
          now,
        );
        expect(lease.activated.account).toEqual({
          provider,
          account_key: accountKey,
          account_generation: 1,
          provider_generation: 1,
        });
        expect(lease.activated.target.provider).toBe(provider);
        const forwarded = await broker.forward(
          forwardCommand(broker, lease, `${provider}-${ordinal}-forward`),
        );
        expect(forwarded.response?.status).toBe(200);
        const publicJson = JSON.stringify({
          receipt: lease.activated,
          admission: forwarded.receipt,
        });
        expect(publicJson).not.toContain('SECRET');
        expect(publicJson).not.toContain(lease.handoff.capability_token);
        await broker.release({
          schema_version: 1,
          request_id: `${provider}-${ordinal}-release`,
          expected_broker_incarnation: broker.incarnation,
          lease_id: lease.activated.lease_id,
          capability_token: lease.handoff.capability_token,
          expected_lease_revision: lease.activated.lease_revision,
          owner,
        });
        now += 1;
      }
    }
    const durable = readFileSync(fxBrokerStateFile(fixture.paths), 'utf8');
    for (const account of authority.accounts.values()) {
      expect(durable).not.toContain(account.secret);
      expect(durable).not.toContain(account.refresh_secret);
    }
    expect(durable).not.toContain('synthetic only');
    expect(durable).not.toContain('capability_token');
    expect(durable).not.toContain('consumer_nonce');
    expect(authority.forwards).toBe(4);
  });

  test('pins provider/account generations while AgentUsage alone rotates credentials', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    const now = 1_800_000_100_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    const lease = await activeLease(broker, 'codex', 'codex-1', 'rotation', now);
    authority.accounts.get('codex-1')!.refresh_next = true;
    const [first, second] = await Promise.all([
      broker.forward(forwardCommand(broker, lease, 'rotate-forward-a')),
      broker.forward(forwardCommand(broker, lease, 'rotate-forward-b')),
    ]);
    expect(first.receipt.disposition).toBe('forwarded');
    expect(second.receipt.disposition).toBe('forwarded');
    expect(authority.refreshes).toBe(1);
    expect(authority.maxActiveForwards).toBe(1);
    expect(JSON.stringify(first)).not.toContain('ROTATED_SECRET');

    authority.accounts.get('codex-1')!.credential_revision = 1;
    await expectRefusal(
      broker.forward(forwardCommand(broker, lease, 'credential-rollback')),
      'capability_stale',
    );
    authority.accounts.get('codex-1')!.credential_revision = 2;

    authority.accounts.get('codex-1')!.account_generation += 1;
    await expectRefusal(
      broker.renew({
        schema_version: 1,
        request_id: 'stale-account-renew',
        expected_broker_incarnation: broker.incarnation,
        lease_id: lease.activated.lease_id,
        capability_token: lease.handoff.capability_token,
        expected_lease_revision: lease.activated.lease_revision,
        owner,
        requested_ttl_ms: 60_000,
      }),
      'generation_mismatch',
    );

    const other = await activeLease(broker, 'grok', 'grok-1', 'target-stale', now);
    authority.accounts.get('grok-1')!.target = {
      ...target('grok'),
      target_revision: 'grok-target-r2',
      capability_capture_id: 'grok-capture-2',
      capability_digest: sha('grok:grok-test:capabilities:r2'),
    };
    await expectRefusal(
      broker.renew({
        schema_version: 1,
        request_id: 'stale-target-renew',
        expected_broker_incarnation: broker.incarnation,
        lease_id: other.activated.lease_id,
        capability_token: other.handoff.capability_token,
        expected_lease_revision: other.activated.lease_revision,
        owner,
        requested_ttl_ms: 60_000,
      }),
      'capability_stale',
    );
  });

  test('deduplicates prepare and fences concurrent account claims and activation', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    const now = 1_800_000_200_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    const command = prepareCommand(broker, 'grok', 'grok-1', 'same-prepare', now);
    const [first, replay] = await Promise.all([
      broker.prepare(command),
      broker.prepare(command),
    ]);
    expect(first.receipt.lease_id).toBe(replay.receipt.lease_id);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(first.handoff?.capability_token).toBe(replay.handoff?.capability_token);

    await expectRefusal(
      broker.prepare(
        prepareCommand(broker, 'grok', 'grok-1', 'other-claim', now),
      ),
      'capacity_unavailable',
    );

    const native = {
      process_instance_id: 'process-concurrent',
      fx_build_revision: 'fake-fx-build-1',
      session_id: 'session-concurrent',
    };
    const activation = {
      schema_version: 1 as const,
      expected_broker_incarnation: broker.incarnation,
      lease_id: first.receipt.lease_id,
      capability_token: first.handoff!.capability_token,
      expected_lease_revision: 1,
      owner,
      native,
    };
    const outcomes = await Promise.allSettled([
      broker.activate({ ...activation, request_id: 'activate-a' }),
      broker.activate({ ...activation, request_id: 'activate-b' }),
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  });

  test('expiry and revocation are absorbing and refuse forwarding', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    let now = 1_800_000_300_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    const prepared = await broker.prepare(
      prepareCommand(broker, 'codex', 'codex-1', 'expires', now, {
        requested_ttl_ms: 2_000,
      }),
    );
    now += 2_001;
    await expectRefusal(
      broker.activate({
        schema_version: 1,
        request_id: 'expired-activation',
        expected_broker_incarnation: broker.incarnation,
        lease_id: prepared.receipt.lease_id,
        capability_token: prepared.handoff!.capability_token,
        expected_lease_revision: 1,
        owner,
        native: {
          process_instance_id: 'expired-process',
          fx_build_revision: 'fake-fx-build-1',
          session_id: null,
        },
      }),
      'expired',
    );

    const active = await activeLease(broker, 'grok', 'grok-1', 'revoke', now);
    const revoked = await broker.revoke({
      schema_version: 1,
      request_id: 'revoke-command',
      expected_broker_incarnation: broker.incarnation,
      lease_id: active.activated.lease_id,
      reason: 'operator',
    });
    expect(revoked.state).toBe('revoked');
    await expectRefusal(
      broker.forward(forwardCommand(broker, active, 'revoked-forward')),
      'stale_fence',
    );
    expect((await broker.get(active.activated.lease_id)).state).toBe('revoked');

    const expiring = await activeLease(broker, 'grok', 'grok-2', 'mid-inspect', now);
    authority.inspectHook = () => {
      now += 100_000;
      authority.inspectHook = null;
    };
    await expectRefusal(
      broker.forward(forwardCommand(broker, expiring, 'expires-mid-inspect')),
      'expired',
    );
    expect(authority.forwards).toBe(0);
    now -= 200_000;
    expect((await broker.get(expiring.activated.lease_id)).state).toBe('expired');

    const pending = await broker.prepare(
      prepareCommand(broker, 'codex', 'codex-2', 'activate-mid-inspect', now),
    );
    authority.inspectHook = () => {
      now += 100_000;
      authority.inspectHook = null;
    };
    await expectRefusal(
      broker.activate({
        schema_version: 1,
        request_id: 'activation-crosses-expiry',
        expected_broker_incarnation: broker.incarnation,
        lease_id: pending.receipt.lease_id,
        capability_token: pending.handoff!.capability_token,
        expected_lease_revision: pending.receipt.lease_revision,
        owner,
        native: {
          process_instance_id: 'late-process',
          fx_build_revision: 'fake-fx-build-1',
          session_id: 'late-session',
        },
      }),
      'expired',
    );
    now -= 200_000;
    expect((await broker.get(pending.receipt.lease_id)).state).toBe('expired');
  });

  test('short renewal is valid and forwarding snapshots mutable request bytes', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    const now = 1_800_000_350_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    const active = await activeLease(broker, 'codex', 'codex-1', 'snapshot', now);
    const pending = await broker.prepare(
      prepareCommand(broker, 'codex', 'codex-2', 'short-pending', now),
    );
    const pendingRenewed = await broker.renew({
      schema_version: 1,
      request_id: 'short-pending-renewal',
      expected_broker_incarnation: broker.incarnation,
      lease_id: pending.receipt.lease_id,
      capability_token: pending.handoff!.capability_token,
      expected_lease_revision: pending.receipt.lease_revision,
      owner,
      requested_ttl_ms: 1_000,
    });
    expect(pendingRenewed.expires_at_ms).toBe(now + 1_000);
    expect(pendingRenewed.activate_before_ms).toBe(now + 1_000);
    authority.inspectDelayMs = 10;
    const activationCommand = {
      schema_version: 1 as const,
      request_id: 'mutable-activation',
      expected_broker_incarnation: broker.incarnation,
      lease_id: pendingRenewed.lease_id,
      capability_token: pending.handoff!.capability_token,
      expected_lease_revision: pendingRenewed.lease_revision,
      owner,
      native: {
        process_instance_id: 'original-process',
        fx_build_revision: 'fake-fx-build-1',
        session_id: 'original-session',
      },
    };
    const activation = broker.activate(activationCommand);
    activationCommand.native.process_instance_id = 'mutated-process';
    expect((await activation).native?.process_instance_id).toBe(
      'original-process',
    );

    const renewCommand = {
      schema_version: 1,
      request_id: 'short-renewal',
      expected_broker_incarnation: broker.incarnation,
      lease_id: active.activated.lease_id,
      capability_token: active.handoff.capability_token,
      expected_lease_revision: active.activated.lease_revision,
      owner,
      requested_ttl_ms: 1_000,
    } as const satisfies FxBrokerRenewCommand;
    const mutableRenewCommand: FxBrokerRenewCommand = { ...renewCommand };
    const renewal = broker.renew(mutableRenewCommand);
    mutableRenewCommand.requested_ttl_ms = 300_000;
    const renewed = await renewal;
    expect(renewed.expires_at_ms).toBe(now + 1_000);

    const original = Buffer.from('first');
    const command: FxBrokerForwardCommand = {
      ...forwardCommand(broker, active, 'mutable-body'),
      expected_lease_revision: renewed.lease_revision,
      operation: 'catalog',
      body: original,
    };
    const admission = broker.forward(command);
    original.set(Buffer.from('other'));
    command.operation = 'inference';
    const admitted = await admission;
    expect(admitted.receipt.disposition).toBe('forwarded');
    expect(authority.forwardedBodies.at(-1)).toBe('first');
    expect(authority.forwardedOperations.at(-1)).toBe('catalog');
    original.set(Buffer.from('first'));
    command.operation = 'catalog';
    const replay = await broker.forward(command);
    expect(replay.replayed).toBe(true);
    expect(authority.forwards).toBe(1);
  });

  test('restart fences capabilities and forwarding loss never repeats provider admission', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    const now = 1_800_000_400_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    const command = prepareCommand(broker, 'codex', 'codex-1', 'restart', now);
    const active = await activeLease(broker, 'grok', 'grok-1', 'lost', now);
    authority.failNext = true;
    const forward = forwardCommand(broker, active, 'lost-forward');
    await expectRefusal(
      broker.forward(forward),
      'refresh_outcome_unknown',
    );
    const replay = await broker.forward(forward);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.disposition).toBe('outcome_unknown');
    expect(replay.response).toBeNull();
    expect(authority.forwards).toBe(1);

    const prepared = await broker.prepare(command);
    const replacement = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    await expectRefusal(
      broker.get(prepared.receipt.lease_id),
      'broker_unavailable',
    );
    const historical = await replacement.prepare({
      ...command,
      expected_broker_incarnation: replacement.incarnation,
    });
    expect(historical.replayed).toBe(true);
    expect(historical.receipt.state).toBe('prepared');
    expect(historical.handoff).toBeNull();
    expect((await replacement.get(prepared.receipt.lease_id)).state).toBe(
      'revoked',
    );
    await expectRefusal(
      broker.prepare(
        prepareCommand(broker, 'codex', 'codex-2', 'old-broker-effect', now, {
          expected_broker_incarnation: replacement.incarnation,
        }),
      ),
      'broker_unavailable',
    );
    const recoveredForward = await replacement.forward({
      ...forward,
      expected_broker_incarnation: replacement.incarnation,
    });
    expect(recoveredForward.replayed).toBe(true);
    expect(recoveredForward.receipt.disposition).toBe('outcome_unknown');
    expect(authority.forwards).toBe(1);
  });

  test('maps authority errors and unsafe input to bounded fixed refusals', async () => {
    const fixture = fixtureState();
    const authority = new FakeAuthority();
    const now = 1_800_000_500_000;
    const broker = await FxCredentialBroker.open(fixture.paths, authority, {
      clock: () => now,
    });
    authority.inspectError = new Error('ACCESS_SECRET_CODEX_1');
    await expectRefusal(
      broker.prepare(prepareCommand(broker, 'codex', 'codex-1', 'hidden', now)),
      'identity_unavailable',
      (error) => expect(JSON.stringify(error.receipt)).not.toContain('SECRET'),
    );
    authority.inspectError = null;
    authority.inspectOverride = {
      ...(await authority.inspect('codex', 'codex-2')),
      account_key: 'codex-2',
    };
    await expectRefusal(
      broker.prepare(
        prepareCommand(broker, 'codex', 'codex-1', 'wrong-authority', now),
      ),
      'identity_unavailable',
    );
    authority.inspectOverride = null;
    const active = await activeLease(broker, 'codex', 'codex-1', 'headers', now);
    const unsafe = forwardCommand(broker, active, 'unsafe-header');
    unsafe.headers.authorization = 'Bearer ACCESS_SECRET_CODEX_1';
    await expectRefusal(
      broker.forward(unsafe),
      'invalid_request',
    );
    expect(authority.forwards).toBe(0);
    for (const [name, value] of [
      ['chatgpt-account-id', 'other-account'],
      ['x-api-key', 'ACCESS_SECRET_CODEX_1'],
    ] as const) {
      const alternate = forwardCommand(broker, active, `unsafe-${name}`);
      alternate.headers[name] = value;
      await expectRefusal(broker.forward(alternate), 'invalid_request');
    }

    authority.accounts.get('codex-1')!.activation_supported = false;
    await expectRefusal(
      broker.forward(forwardCommand(broker, active, 'unsupported-adapter')),
      'adapter_unsupported',
    );
    authority.accounts.get('codex-1')!.activation_supported = true;

    authority.responseHeaders = {
      'content-type': 'application/json',
      'set-cookie': 'ACCESS_SECRET_CODEX_1',
      'x-credential': 'REFRESH_SECRET_CODEX_1',
    };
    const safe = await broker.forward(
      forwardCommand(broker, active, 'safe-response-headers'),
    );
    expect(safe.response?.headers).toEqual({
      'content-type': 'application/json',
    });
    expect(JSON.stringify(safe)).not.toContain('SECRET');
  });
});
