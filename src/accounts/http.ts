import { AccountError } from './storage.ts';
import type { ManagedProvider } from './store.ts';
export type Env = Record<string, string | undefined>;
export function providerURL(
  provider: ManagedProvider | 'grok',
  path: string,
  env: Env = process.env,
  oauth = false,
): string {
  const testOrigin = env[`AGENTUSAGE_TEST_${provider.toUpperCase()}_ORIGIN`];
  const origin =
    testOrigin ??
    (provider === 'grok'
      ? oauth
        ? 'https://auth.x.ai'
        : 'https://cli-chat-proxy.grok.com'
      : provider === 'codex'
      ? oauth
        ? 'https://auth.openai.com'
        : 'https://chatgpt.com'
      : oauth
        ? 'https://platform.claude.com'
        : 'https://api.anthropic.com');
  const url = new URL(origin);
  if (
    testOrigin &&
    (!env.AGENTUSAGE_STATE_ROOT ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash)
  )
    throw new AccountError(
      'invalid-test-origin',
      'Test endpoints require an isolated state root and an HTTP IPv4 loopback origin',
    );
  return new URL(path, url).toString();
}
export async function readCapped(
  response: Response,
  limit = 256 * 1024,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new AccountError(
          'response-too-large',
          'Provider response exceeded its size limit',
          502,
        );
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export async function jsonBody(
  response: Response,
): Promise<Record<string, unknown>> {
  const bytes = await readCapped(response);
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed;
  } catch {}
  throw new AccountError(
    'invalid-response',
    'Provider returned invalid JSON',
    502,
  );
}
export function retryDelay(response: Response, nowMs = Date.now()): number {
  const raw = response.headers.get('retry-after');
  const seconds = raw === null ? NaN : Number(raw);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : raw === null
      ? NaN
      : Date.parse(raw) - nowMs;
  return Number.isFinite(ms)
    ? Math.min(7 * 86400_000, Math.max(60_000, ms))
    : 60_000;
}
