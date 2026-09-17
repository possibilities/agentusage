import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AccountError, lockFile, record } from '../accounts/storage.ts';
import type { StatePaths } from '../paths.ts';
import { FxCredentialBroker } from './broker.ts';
import { GrokFxAuthority } from './grok-authority.ts';
import { CodexFxAuthority } from './codex-authority.ts';
import { withRoutingEvidenceSnapshot } from '../routing-evidence/projection.ts';
import type { FxBrokerBindingReceipt, FxBrokerNativeBinding, FxBrokerOwner } from './types.ts';

const MAX_LINE = 16 * 1024;
const MAX_BODY = 1024 * 1024;
const BROKER_PREPARE_REVISION = 'broker_prepare';
function invalid(): never { throw new AccountError('invalid_request', 'Invalid broker bridge request', 400); }
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);

/** Private parent/child stdio, one execution and one owned loopback listener.
 * Endpoint capabilities are deliberately not durable or manager-facing.
 */
export async function runFxBridge(paths: StatePaths): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inputBytes = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    inputBytes += chunk.byteLength;
    if (inputBytes > 64 * 1024) { lines.close(); process.stdin.destroy(); }
  });
  let close: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const iterator = lines[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || Buffer.byteLength(first.value) > MAX_LINE) invalid();
    const input = record(JSON.parse(first.value));
    const selection = record(input?.selection);
    const owner = record(input?.owner);
    if (!input || Object.keys(input).sort().join(',') !== 'deadline_ms,owner,schema_version,selection' || input.schema_version !== 1 ||
        !selection || Object.keys(selection).sort().join(',') !== 'account_key,effort,expected_source_revision,model,service_tier' ||
        !owner || Object.keys(owner).sort().join(',') !== 'attempt_id,control_epoch,execution_id,host_id,host_incarnation' ||
        !['host_id', 'host_incarnation', 'execution_id', 'attempt_id'].every(k => id(owner[k])) || owner.control_epoch !== 1 ||
        !Number.isSafeInteger(input.deadline_ms) || Number(input.deadline_ms) <= Date.now() || Number(input.deadline_ms) > Date.now() + 300_000 ||
        typeof selection.account_key !== 'string' || typeof selection.model !== 'string' || typeof selection.effort !== 'string' ||
        !(selection.service_tier === null || selection.service_tier === 'priority') || !(selection.expected_source_revision === BROKER_PREPARE_REVISION ||
          (typeof selection.expected_source_revision === 'string' ? /^[1-9]\d{0,63}$/.test(selection.expected_source_revision) : Number.isSafeInteger(selection.expected_source_revision) && Number(selection.expected_source_revision) > 0))) invalid();
    // A second host cannot revoke the first host by opening a new broker incarnation.
    const releaseLock = await lockFile(join(paths.stateRoot, 'service', 'fx-bridge.lock'), 0);
    close = async () => { releaseLock(); };
    const commandOwner = owner as unknown as FxBrokerOwner;
    const prefix = commandOwner.attempt_id;
    const factory = selection.account_key.startsWith('grok-') ? GrokFxAuthority : CodexFxAuthority;
    // No publication can advance the exact routing revision after this gate
    // validates it and before the broker durably records the lease.
    const { authority, broker, prepared, routingSourceRevision } = await withRoutingEvidenceSnapshot(paths, async evidence => {
      const expectedSourceRevision = selection.expected_source_revision === BROKER_PREPARE_REVISION
        ? evidence.source_revision
        : selection.expected_source_revision;
      const authority = await factory.createWithinSnapshot(paths,
        { ...selection, expected_source_revision: expectedSourceRevision } as unknown as Parameters<typeof CodexFxAuthority.create>[1], evidence);
      const broker = await FxCredentialBroker.open(paths, authority);
      const fence = { schema_version: 1 as const, expected_broker_incarnation: broker.incarnation };
      const prepared = await broker.prepare({ ...fence, request_id: `${prefix}:prepare`, owner: commandOwner,
        target: authority.target, account: { account_key: authority.accountKey, expected_account_generation: Number(authority.accountKey.split('-')[1]), expected_provider_generation: 1 },
        consumer_nonce: randomBytes(32).toString('base64url'), requested_ttl_ms: Math.max(1000, Number(input.deadline_ms) - Date.now()),
        execution_deadline_ms: Number(input.deadline_ms) }, authority.inspectionWithinSnapshot());
      return { authority, broker, prepared, routingSourceRevision: evidence.source_revision };
    });
    const fence = { schema_version: 1 as const, expected_broker_incarnation: broker.incarnation };
    if (!prepared.handoff) invalid();
    let receipt: FxBrokerBindingReceipt = prepared.receipt;
    let native: FxBrokerNativeBinding | null = null;
    const token = prepared.handoff.capability_token;
    const route = randomBytes(32).toString('hex');
    let count = 0;
    let busy = false;
    let closed = false;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: MAX_BODY,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (closed || request.headers.has('origin') || request.headers.has('authorization') ||
            request.headers.has('cookie') || !url.pathname.startsWith(`/${route}/`)) return new Response(null, { status: 403 });
        if (url.pathname === `/${route}/modalities` && request.method === 'GET' && authority instanceof GrokFxAuthority) {
          if (Date.now() >= receipt.expires_at_ms) return new Response(null, { status: 410 });
          return new Response(authority.modalities, { headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname === `/${route}/models` && request.method === 'GET') {
          if (Date.now() >= receipt.expires_at_ms) return new Response(null, { status: 410 });
          return new Response(authority.catalog, { headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname !== `/${route}/responses` || request.method !== 'POST' || !native || busy || count >= 8) return new Response(null, { status: 409 });
        busy = true;
        const requestId = `${prefix}:forward:${++count}`;
        try {
          const body = new Uint8Array(await request.arrayBuffer());
          if (body.byteLength > MAX_BODY) return new Response(null, { status: 413 });
          const result = await broker.forward({ ...fence, request_id: requestId, lease_id: receipt.lease_id,
            capability_token: token, expected_lease_revision: receipt.lease_revision, owner: commandOwner,
            native, target: authority.target, operation: 'inference', body, headers: {} });
          write({ type: 'forward', receipt: result.receipt, http_status: result.response?.status ?? null });
          if (!result.response) { closed = true; return new Response(null, { status: 409 }); }
          if (result.response.status !== 200) closed = true;
          return new Response(result.response.body, { status: result.response.status, headers: result.response.headers });
        } catch {
          write({ type: 'forward_unknown', request_id: requestId });
          // Never retry a lost or refused provider admission, including client retries.
          closed = true;
          return Response.json({ error: { message: 'Broker admission unavailable; do not retry' } }, { status: 409 });
        } finally { busy = false; }
      },
    });
    close = async () => {
      closed = true;
      server.stop(true);
      try {
        receipt = await broker.release({ ...fence, request_id: `${prefix}:release`, lease_id: receipt.lease_id,
          capability_token: token, expected_lease_revision: receipt.lease_revision, owner: commandOwner });
        write({ type: 'released', receipt });
      } finally { releaseLock(); }
    };
    const expire = () => { void close?.().finally(() => { close = undefined; lines.close(); process.stdin.destroy(); }); };
    timer = setTimeout(expire, Math.max(1, Number(input.deadline_ms) - Date.now()));
    write({ type: 'prepared', receipt, evidence: authority.evidence, routing_source_revision: routingSourceRevision,
      private_transport: { catalog_url: `http://127.0.0.1:${server.port}/${route}/models`, chat_url: `http://127.0.0.1:${server.port}/${route}/responses` } });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (Buffer.byteLength(next.value) > MAX_LINE) invalid();
      const command = record(JSON.parse(next.value));
      if (command?.action === 'activate' && !native && Object.keys(command).sort().join(',') === 'action,native') {
        const value = record(command.native);
        if (!value || !id(value.process_instance_id) || !id(value.fx_build_revision) || !id(value.session_id) ||
            Object.keys(value).sort().join(',') !== 'fx_build_revision,process_instance_id,session_id') invalid();
        native = value as unknown as FxBrokerNativeBinding;
        receipt = await broker.activate({ ...fence, request_id: `${prefix}:activate`, lease_id: receipt.lease_id,
          capability_token: token, expected_lease_revision: receipt.lease_revision, owner: commandOwner, native });
        write({ type: 'active', receipt });
      } else if (command?.action === 'release' && Object.keys(command).length === 1) break;
      else invalid();
    }
    return 0;
  } catch (error) {
    write({ type: 'error', code: error instanceof AccountError ? error.code : 'broker_unavailable' });
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    lines.close();
    await close?.().catch(() => {});
  }
}
