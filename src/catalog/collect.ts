import { isAbsolute } from 'node:path';
import { VERSION } from '../version.ts';
import {
  CATALOG_AUDIT_MAX_BYTES,
  COLLECTOR_PROFILE,
  SUPPORTED_COLLECTOR_VERSION,
  CatalogInputError,
  type CatalogAuditInput,
  type CatalogCaptureReceipt,
} from './types.ts';
import { validateCatalogAuditInput } from './validate.ts';

const MODEL_PAGE_LIMIT = 100;
const MAX_PAGES = 128;
const MAX_MODELS = 512;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STRING = 512;

export interface CollectCatalogOptions {
  executable: string;
  expectedVersion: string;
  metadata: CatalogAuditInput['metadata'];
}

export interface CollectCatalogTiming {
  versionTimeoutMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  shutdownGraceMs?: number;
  now?: () => Date;
  randomUUID?: () => string;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CatalogInputError(code);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, code: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING) throw new CatalogInputError(code);
  return value;
}

function boundedUniqueStrings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS) throw new CatalogInputError(code);
  const values = value.map((entry) => boundedString(entry, code) as string);
  if (new Set(values).size !== values.length) throw new CatalogInputError(code);
  return values;
}

function projectModel(value: unknown): Record<string, unknown> {
  const row = object(value, 'invalid-native-model');
  const id = boundedString(row.id, 'invalid-native-model') as string;
  const model = boundedString(row.model, 'invalid-native-model') as string;
  if (typeof row.hidden !== 'boolean' || typeof row.isDefault !== 'boolean') throw new CatalogInputError('invalid-native-model');
  const defaultReasoningEffort = boundedString(row.defaultReasoningEffort, 'invalid-native-model') as string;
  const multiAgentVersion = boundedString(row.multiAgentVersion, 'invalid-native-model', true);
  if (multiAgentVersion !== null && multiAgentVersion !== 'disabled' && multiAgentVersion !== 'v1' && multiAgentVersion !== 'v2') {
    throw new CatalogInputError('invalid-native-model');
  }
  const defaultServiceTier = boundedString(row.defaultServiceTier, 'invalid-native-model', true);
  const inputModalities = boundedUniqueStrings(row.inputModalities, 'invalid-native-model');
  if (inputModalities.some((modality) => modality !== 'text' && modality !== 'image' && modality !== 'audio')) {
    throw new CatalogInputError('invalid-native-model');
  }
  if (!Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.length > MAX_MODELS) throw new CatalogInputError('invalid-native-model');
  const supportedReasoningEfforts = row.supportedReasoningEfforts.map((entry) => ({
    reasoningEffort: boundedString(object(entry, 'invalid-native-model').reasoningEffort, 'invalid-native-model') as string,
  }));
  const efforts = supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  if (new Set(efforts).size !== efforts.length || !efforts.includes(defaultReasoningEffort)) throw new CatalogInputError('invalid-native-model');
  if (!Array.isArray(row.serviceTiers) || row.serviceTiers.length > MAX_MODELS) throw new CatalogInputError('invalid-native-model');
  const serviceTiers = row.serviceTiers.map((entry) => ({
    id: boundedString(object(entry, 'invalid-native-model').id, 'invalid-native-model') as string,
  }));
  const tierIds = serviceTiers.map((entry) => entry.id);
  if (new Set(tierIds).size !== tierIds.length || (defaultServiceTier !== null && !tierIds.includes(defaultServiceTier))) {
    throw new CatalogInputError('invalid-native-model');
  }
  return {
    id,
    model,
    hidden: row.hidden,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    inputModalities,
    multiAgentVersion,
    serviceTiers,
    defaultServiceTier,
    isDefault: row.isDefault,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalOwnedGroup(proc: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch {}
  }
}

function ownedGroupAlive(proc: ReturnType<typeof Bun.spawn>): boolean {
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function capturePipe(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void) {
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  const promise = (async () => {
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        onOverflow();
        throw new CatalogInputError('native-output-limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  })();
  void promise.catch(() => {});
  return {
    promise,
    cancel: () => { try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch {} },
  };
}

async function boundedPipeResult(pipe: ReturnType<typeof capturePipe>, waitMs: number): Promise<string> {
  const marker = Symbol('pipe-timeout');
  const result = await Promise.race([pipe.promise, delay(waitMs).then(() => marker)]);
  if (typeof result !== 'string') {
    pipe.cancel();
    throw new CatalogInputError('native-cleanup-timeout');
  }
  return result;
}

async function readVersion(executable: string, timeoutMs: number, shutdownGraceMs: number): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd: [executable, '--version'], stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch {
    throw new CatalogInputError('native-spawn-failed');
  }
  let overflow = false;
  let interrupted = false;
  const overflowKill = () => { overflow = true; signalOwnedGroup(proc, 'SIGKILL'); };
  const stdout = capturePipe(proc.stdout as ReadableStream<Uint8Array>, 1024, overflowKill);
  const stderr = capturePipe(proc.stderr as ReadableStream<Uint8Array>, 1024, overflowKill);
  const abort = () => { interrupted = true; signalOwnedGroup(proc, 'SIGTERM'); };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  let timedOut = false;
  try {
    const timeout = Symbol('version-timeout');
    const exited = await Promise.race([proc.exited, delay(timeoutMs).then(() => timeout)]);
    if (exited === timeout) {
      timedOut = true;
      signalOwnedGroup(proc, 'SIGKILL');
    }
    if (ownedGroupAlive(proc)) signalOwnedGroup(proc, 'SIGTERM');
    if (ownedGroupAlive(proc)) await delay(shutdownGraceMs);
    if (ownedGroupAlive(proc)) signalOwnedGroup(proc, 'SIGKILL');
    const [outcome, errorOutcome] = await Promise.allSettled([
      boundedPipeResult(stdout, shutdownGraceMs),
      boundedPipeResult(stderr, shutdownGraceMs),
    ]);
    if (interrupted) throw new CatalogInputError('native-aborted');
    if (timedOut) throw new CatalogInputError('native-version-timeout');
    if (overflow || outcome.status === 'rejected' || errorOutcome.status === 'rejected') throw new CatalogInputError('native-output-limit');
    if (proc.exitCode !== 0) throw new CatalogInputError('codex-version-mismatch');
    return outcome.value;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    signalOwnedGroup(proc, 'SIGKILL');
    stdout.cancel();
    stderr.cancel();
  }
}

class JsonlReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffered = '';
  private totalBytes = 0;
  private pendingTail = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  cancel(): void {
    try { void Promise.resolve(this.iterator.return?.()).catch(() => {}); } catch {}
  }

  hasBufferedBytes(): boolean {
    return this.buffered.length > 0 || this.pendingTail;
  }

  async next(deadlineMs: number, requestTimeoutMs: number): Promise<Record<string, unknown>> {
    while (true) {
      const newline = this.buffered.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/u, '');
        this.buffered = this.buffered.slice(newline + 1);
        if (line.length === 0 || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new CatalogInputError('malformed-native-output');
        try {
          return object(JSON.parse(line), 'malformed-native-output');
        } catch (error) {
          if (error instanceof CatalogInputError) throw error;
          throw new CatalogInputError('malformed-native-output');
        }
      }
      const remaining = Math.min(requestTimeoutMs, deadlineMs - Date.now());
      if (remaining <= 0) throw new CatalogInputError('native-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CatalogInputError('native-timeout')), remaining);
      });
      let result: IteratorResult<Uint8Array, unknown>;
      try {
        result = await Promise.race([this.iterator.next(), timed]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done === true) {
        try { this.buffered += this.decoder.decode(); } catch { throw new CatalogInputError('malformed-native-output'); }
        if (this.buffered.length > 0) throw new CatalogInputError('malformed-native-output');
        throw new CatalogInputError('native-exited');
      }
      this.totalBytes += result.value.byteLength;
      if (this.totalBytes > MAX_STDOUT_BYTES) throw new CatalogInputError('native-output-limit');
      try {
        this.buffered += this.decoder.decode(result.value, { stream: true });
      } catch {
        throw new CatalogInputError('malformed-native-output');
      }
      this.pendingTail = result.value.at(-1) !== 0x0a;
      if (Buffer.byteLength(this.buffered) > MAX_LINE_BYTES) throw new CatalogInputError('malformed-native-output');
    }
  }
}

async function stopOwnedChild(proc: ReturnType<typeof Bun.spawn>, graceMs: number): Promise<void> {
  try {
    if (typeof proc.stdin === 'object' && proc.stdin !== null && 'end' in proc.stdin) proc.stdin.end();
  } catch {}
  if (proc.exitCode === null) await Promise.race([proc.exited.then(() => undefined), delay(graceMs)]);
  if (ownedGroupAlive(proc)) signalOwnedGroup(proc, 'SIGTERM');
  if (ownedGroupAlive(proc)) await delay(graceMs);
  if (ownedGroupAlive(proc)) signalOwnedGroup(proc, 'SIGKILL');
  if (proc.exitCode === null) await Promise.race([proc.exited.then(() => undefined), delay(graceMs)]);
}

async function send(proc: ReturnType<typeof Bun.spawn>, message: Record<string, unknown>, deadlineMs: number): Promise<void> {
  if (typeof proc.stdin !== 'object' || proc.stdin === null || !('write' in proc.stdin)) throw new CatalogInputError('native-exited');
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new CatalogInputError('native-timeout');
  proc.stdin.write(`${JSON.stringify(message)}\n`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(proc.stdin.flush()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CatalogInputError('native-timeout')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function responseFor(reader: JsonlReader, expectedId: number, deadlineMs: number, requestTimeoutMs: number): Promise<Record<string, unknown>> {
  const requestDeadline = Math.min(deadlineMs, Date.now() + requestTimeoutMs);
  while (true) {
    const message = await reader.next(requestDeadline, requestTimeoutMs);
    if ('jsonrpc' in message) throw new CatalogInputError('unexpected-native-message');
    const hasMethod = 'method' in message;
    const hasId = 'id' in message;
    if (hasMethod && hasId) throw new CatalogInputError('unexpected-server-request');
    if (hasMethod) {
      if ('result' in message || 'error' in message) throw new CatalogInputError('unexpected-native-message');
      boundedString(message.method, 'unexpected-native-message');
      continue;
    }
    if (!hasId || message.id !== expectedId) throw new CatalogInputError('unexpected-native-response');
    if ('error' in message && 'result' in message) throw new CatalogInputError('unexpected-native-message');
    if ('error' in message || !('result' in message)) throw new CatalogInputError('native-request-failed');
    return object(message.result, 'malformed-native-output');
  }
}

async function drainCompletion(reader: JsonlReader, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (true) {
    let message: Record<string, unknown>;
    try {
      message = await reader.next(deadline, waitMs);
    } catch (error) {
      if (error instanceof CatalogInputError && error.code === 'native-exited') return;
      if (error instanceof CatalogInputError && error.code === 'native-timeout' && !reader.hasBufferedBytes()) return;
      throw error;
    }
    if ('jsonrpc' in message) throw new CatalogInputError('unexpected-native-message');
    if ('method' in message && !('id' in message) && !('result' in message) && !('error' in message)) {
      boundedString(message.method, 'unexpected-native-message');
      continue;
    }
    if ('method' in message && 'id' in message) throw new CatalogInputError('unexpected-server-request');
    throw new CatalogInputError('unexpected-native-response');
  }
}

export async function collectCatalog(options: CollectCatalogOptions, timing: CollectCatalogTiming = {}): Promise<CatalogAuditInput> {
  if (process.platform === 'win32') throw new CatalogInputError('unsupported-collector-platform');
  if (options.expectedVersion !== SUPPORTED_COLLECTOR_VERSION) throw new CatalogInputError('unsupported-collector-version');
  if (!isAbsolute(options.executable)) throw new CatalogInputError('codex-path-must-be-absolute');
  const metadata = validateCatalogAuditInput({
    schema_version: 1,
    metadata: options.metadata,
    native_catalog: {
      source: 'codex_app_server_model_list',
      client_version: SUPPORTED_COLLECTOR_VERSION,
      observed_at: new Date().toISOString(),
      pages: [{ data: [], nextCursor: null }],
    },
    usage: null,
  }).metadata;
  const shutdownGraceMs = timing.shutdownGraceMs ?? 250;
  const version = await readVersion(options.executable, timing.versionTimeoutMs ?? 3_000, shutdownGraceMs);
  if (version !== `codex-cli ${SUPPORTED_COLLECTOR_VERSION}\n` && version !== `codex-cli ${SUPPORTED_COLLECTOR_VERSION}\r\n`) {
    throw new CatalogInputError('codex-version-mismatch');
  }

  const now = timing.now ?? (() => new Date());
  const captureId = timing.randomUUID === undefined ? crypto.randomUUID() : timing.randomUUID();
  const startedAt = now().toISOString();
  const requestTimeoutMs = timing.requestTimeoutMs ?? 5_000;
  const totalDeadline = Date.now() + (timing.totalTimeoutMs ?? 30_000);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [options.executable, 'app-server', '--listen', 'stdio://'],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch {
    throw new CatalogInputError('native-spawn-failed');
  }
  let stderrError: CatalogInputError | null = null;
  const stderrPipe = capturePipe(proc.stderr as ReadableStream<Uint8Array>, MAX_STDERR_BYTES, () => {
    stderrError = new CatalogInputError('native-output-limit');
    signalOwnedGroup(proc, 'SIGKILL');
  });
  const stderrTask = stderrPipe.promise.catch((error) => {
    stderrError = error instanceof CatalogInputError ? error : new CatalogInputError('native-output-limit');
    return '';
  });
  let interrupted = false;
  const abort = () => { interrupted = true; signalOwnedGroup(proc, 'SIGTERM'); };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  let reader: JsonlReader | undefined;
  try {
    reader = new JsonlReader(proc.stdout as ReadableStream<Uint8Array>);
    const initializeDeadline = Math.min(totalDeadline, Date.now() + requestTimeoutMs);
    await send(proc, {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agentusage_catalog_collector', title: 'AgentUsage Catalog Collector', version: VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    }, initializeDeadline);
    const initialized = await responseFor(reader, 1, initializeDeadline, requestTimeoutMs);
    for (const key of ['userAgent', 'codexHome', 'platformFamily', 'platformOs']) boundedString(initialized[key], 'malformed-native-output');
    if (!isAbsolute(initialized.codexHome as string)) throw new CatalogInputError('malformed-native-output');
    await send(proc, { method: 'initialized' }, Math.min(totalDeadline, Date.now() + requestTimeoutMs));

    const pages: CatalogAuditInput['native_catalog']['pages'] = [];
    const receiptPages: CatalogCaptureReceipt['pages'] = [];
    const cursors = new Set<string>();
    const modelIds = new Set<string>();
    let requestedCursor: string | null = null;
    let modelCount = 0;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const requestId = pageIndex + 2;
      const requestDeadline = Math.min(totalDeadline, Date.now() + requestTimeoutMs);
      await send(proc, { id: requestId, method: 'model/list', params: { cursor: requestedCursor, limit: MODEL_PAGE_LIMIT, includeHidden: true } }, requestDeadline);
      const result = await responseFor(reader, requestId, requestDeadline, requestTimeoutMs);
      if (!Array.isArray(result.data) || result.data.length > MODEL_PAGE_LIMIT) throw new CatalogInputError('invalid-native-page');
      const data = result.data.map(projectModel);
      const nextCursor = boundedString(result.nextCursor, 'invalid-native-page', true);
      modelCount += data.length;
      if (modelCount > MAX_MODELS) throw new CatalogInputError('native-model-limit');
      for (const row of data) {
        const model = row.model as string;
        if (modelIds.has(model)) throw new CatalogInputError('duplicate-native-model');
        modelIds.add(model);
      }
      if (nextCursor !== null) {
        if (cursors.has(nextCursor)) throw new CatalogInputError('repeated-native-cursor');
        cursors.add(nextCursor);
      }
      pages.push({ data, nextCursor });
      receiptPages.push({ request_id: requestId, requested_cursor: requestedCursor, returned_next_cursor: nextCursor, include_hidden: true, limit: MODEL_PAGE_LIMIT, model_count: data.length });
      if (nextCursor === null) break;
      requestedCursor = nextCursor;
    }
    if (pages.length === MAX_PAGES && pages.at(-1)!.nextCursor !== null) throw new CatalogInputError('native-page-limit');
    if (typeof proc.stdin === 'object' && proc.stdin !== null && 'end' in proc.stdin) proc.stdin.end();
    await drainCompletion(reader, shutdownGraceMs);
    if (interrupted) throw new CatalogInputError('native-aborted');
    const completedAt = now().toISOString();
    const bundle: CatalogAuditInput = {
      schema_version: 1,
      metadata,
      native_catalog: {
        source: 'codex_app_server_model_list',
        client_version: SUPPORTED_COLLECTOR_VERSION,
        observed_at: completedAt,
        pages,
        capture_receipt: {
          schema_version: 1,
          profile: COLLECTOR_PROFILE,
          capture_id: captureId,
          expected_version: SUPPORTED_COLLECTOR_VERSION,
          reported_version: SUPPORTED_COLLECTOR_VERSION,
          started_at: startedAt,
          completed_at: completedAt,
          complete: true,
          pages: receiptPages,
        },
      },
      usage: null,
    };
    if (Buffer.byteLength(JSON.stringify(bundle)) + 1 > CATALOG_AUDIT_MAX_BYTES) throw new CatalogInputError('capture-too-large');
    return validateCatalogAuditInput(bundle);
  } catch (error) {
    if (stderrError !== null) throw stderrError;
    if (error instanceof CatalogInputError) throw error;
    throw new CatalogInputError('catalog-collection-failed');
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    await stopOwnedChild(proc, shutdownGraceMs);
    reader?.cancel();
    stderrPipe.cancel();
    await Promise.race([stderrTask, delay(shutdownGraceMs)]);
    if (stderrError !== null) throw stderrError;
  }
}
