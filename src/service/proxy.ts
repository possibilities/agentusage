import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { StatePaths } from '../paths.ts';
import {
  AccountError,
  checkPrivateDirectory,
  lockFile,
  privateDirectory,
  readPrivate,
  record,
  writePrivate,
} from '../accounts/storage.ts';
import {
  accessAccount,
  providerHeaders,
  rejectCredential,
} from '../accounts/credentials.ts';
import { providerURL, readCapped, type Env } from '../accounts/http.ts';
import {
  authorizedLease,
  readLeases,
  renewLease,
  serviceDirectory,
} from './leases.ts';
import type { ManagedProvider } from '../accounts/store.ts';
import {
  quotaResetAt,
  rebalanceLease,
  recordQuotaExhaustion,
  replayableRequest,
} from './quota.ts';

export const DEFAULT_PROXY_PORT = 43623;
export interface ServiceEndpoint {
  schema_version: 1;
  port: number;
  secret: string;
}
const endpointFile = (paths: StatePaths) =>
  join(serviceDirectory(paths), 'endpoint.json');
export function readEndpoint(paths: StatePaths): ServiceEndpoint | null {
  checkPrivateDirectory(paths.stateRoot);
  return readPrivate(
    endpointFile(paths),
    (value) => {
      const e = record(value);
      if (
        e?.schema_version !== 1 ||
        !Number.isSafeInteger(e.port) ||
        Number(e.port) < 1 ||
        Number(e.port) > 65535 ||
        typeof e.secret !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(e.secret)
      )
        throw new AccountError('invalid-state', 'Invalid daemon endpoint');
      return value as ServiceEndpoint;
    },
    () => null,
  );
}
export const endpointURL = (e: ServiceEndpoint) => `http://127.0.0.1:${e.port}`;
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function jsonError(error: unknown): Response {
  const e =
    error instanceof AccountError
      ? error
      : new AccountError(
          'upstream-unavailable',
          'The managed account request could not complete',
          502,
        );
  return Response.json(
    {
      schema_version: 1,
      ok: false,
      error: { code: e.code, message: e.message },
    },
    { status: e.status },
  );
}
function upstreamPath(
  provider: ManagedProvider,
  path: string,
  method: string,
): string | null {
  if (provider === 'claude') {
    if (method === 'POST' && /^\/v1\/messages(?:\/count_tokens)?$/u.test(path))
      return path;
    if (
      method === 'GET' &&
      /^\/(?:v1\/models(?:\/[a-zA-Z0-9._-]+)?|api\/oauth\/(?:usage|profile))$/u.test(
        path,
      )
    )
      return path;
  } else {
    if (method === 'GET' && path === '/models') return '/backend-api/models';
    if (method === 'POST' && /^\/responses(?:\/compact)?$/u.test(path))
      return '/backend-api/codex' + path;
  }
  return null;
}
function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  const hop = (headers.get('connection') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const key of [
    ...hop,
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'set-cookie',
    'content-encoding',
    'content-length',
    'access-control-allow-origin',
  ])
    headers.delete(key);
  return headers;
}
export interface ProxyOptions {
  env?: Env;
  port?: number;
  maxRequests?: number;
  maxBodyBytes?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxStreamMs?: number;
}
export async function startProxy(
  paths: StatePaths,
  options: ProxyOptions = {},
) {
  privateDirectory(paths.stateRoot);
  const release = await lockFile(
    join(serviceDirectory(paths), 'daemon.lock'),
    0,
  );
  const env = options.env ?? process.env;
  const controllers = new Set<AbortController>();
  let active = 0,
    buffered = 0,
    stopping = false;
  let started: { stop(close?: boolean): unknown } | undefined;
  try {
    const previous = readEndpoint(paths);
    const port =
      options.port ??
      previous?.port ??
      (env.AGENTUSAGE_PROXY_PORT
        ? Number(env.AGENTUSAGE_PROXY_PORT)
        : DEFAULT_PROXY_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new AccountError(
        'invalid-port',
        'Proxy port must be an integer between 0 and 65535',
      );
    const secret = previous?.secret ?? randomBytes(32).toString('hex');
    const maxBody = options.maxBodyBytes ?? 32 * 1024 * 1024;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      maxRequestBodySize: maxBody,
      idleTimeout: 0,
      async fetch(req) {
        try {
          const url = new URL(req.url);
          if (
            req.headers.has('origin') ||
            req.headers.get('host') !== `127.0.0.1:${server.port}`
          )
            throw new AccountError(
              'local-only',
              'Only direct loopback clients are accepted',
              403,
            );
          const token = (req.headers.get('authorization') ?? '').replace(
            /^Bearer /u,
            '',
          );
          if (url.pathname === '/health' && req.method === 'GET') {
            if (!sameSecret(token, secret))
              throw new AccountError(
                'unauthorized',
                'Daemon authentication required',
                401,
              );
            return Response.json(
              { schema_version: 1, ok: !stopping, active_requests: active },
              { status: stopping ? 503 : 200 },
            );
          }
          if (
            url.pathname === '/lease' &&
            (req.method === 'POST' || req.method === 'DELETE')
          ) {
            const lease = await renewLease(
              paths,
              token,
              req.method === 'DELETE',
            );
            return Response.json({ schema_version: 1, ok: true, ...lease });
          }
          // Native Claude's initial connectivity probe carries no credential.
          if (url.pathname === '/claude/api/hello' && req.method === 'HEAD')
            return new Response(null, { status: 204 });
          const match = /^\/(claude|codex)(\/.*)$/u.exec(url.pathname);
          if (!match)
            throw new AccountError(
              'unsupported-endpoint',
              'Unsupported native provider endpoint',
              404,
            );
          const provider = match[1] as ManagedProvider,
            path = upstreamPath(provider, match[2]!, req.method);
          if (!path)
            throw new AccountError(
              'unsupported-endpoint',
              'Unsupported native provider endpoint',
              404,
            );
          const lease = authorizedLease(readLeases(paths), token, provider);
          if (stopping || active >= (options.maxRequests ?? 32))
            throw new AccountError(
              'service-busy',
              'Daemon is at its request limit or draining',
              503,
            );
          active++;
          const abort = new AbortController();
          controllers.add(abort);
          let bytes = 0,
            done = false;
          let headerTimer: ReturnType<typeof setTimeout> | undefined,
            idleTimer: ReturnType<typeof setTimeout> | undefined;
          let responseReader:
            | Pick<
                ReadableStreamDefaultReader<Uint8Array>,
                'read' | 'cancel' | 'releaseLock'
              >
            | undefined;
          let streamController:
            | ReadableStreamDefaultController<Uint8Array>
            | undefined;
          const hardTimer = setTimeout(
            () => abort.abort(),
            options.maxStreamMs ?? 3_600_000,
          );
          const onClientAbort = () => abort.abort();
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(hardTimer);
            clearTimeout(headerTimer);
            clearTimeout(idleTimer);
            req.signal.removeEventListener('abort', onClientAbort);
            abort.signal.removeEventListener('abort', onStreamAbort);
            controllers.delete(abort);
            active--;
            buffered -= bytes;
            bytes = 0;
          };
          const onStreamAbort = () => {
            if (!responseReader || done) return; // Buffered work releases its resources in catch.
            try {
              streamController?.error(
                new Error('Provider stream was cancelled or timed out'),
              );
            } catch {}
            void responseReader.cancel().catch(() => {});
            finish();
          };
          req.signal.addEventListener('abort', onClientAbort, { once: true });
          abort.signal.addEventListener('abort', onStreamAbort, { once: true });
          const idle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => abort.abort(),
              options.idleTimeoutMs ?? 300_000,
            );
          };
          const headerDeadline = () => {
            clearTimeout(headerTimer);
            headerTimer = setTimeout(
              () => abort.abort(),
              options.headerTimeoutMs ?? 90_000,
            );
          };
          try {
            if (req.signal.aborted) abort.abort();
            abort.signal.throwIfAborted();
            headerDeadline();
            let body: Uint8Array | undefined;
            let payload: Record<string, unknown> | null = null;
            if (req.method === 'POST') {
              if (buffered + maxBody > 128 * 1024 * 1024)
                throw new AccountError(
                  'service-busy',
                  'Daemon request buffer is full',
                  503,
                );
              bytes = maxBody;
              buffered += bytes;
              body = await readCapped(
                new Response(req.body),
                maxBody,
                abort.signal,
              );
              buffered -= bytes - body.byteLength;
              bytes = body.byteLength;
              if (provider === 'codex') {
                try {
                  payload = record(JSON.parse(Buffer.from(body).toString()));
                } catch {}
              }
            }
            const model =
              typeof payload?.model === 'string' ? payload.model : lease.model;
            let account = await accessAccount(paths, lease.account_key, env);
            const upstream = new URL(providerURL(provider, path, env));
            upstream.search = url.search;
            const send = async (): Promise<Response> => {
              abort.signal.throwIfAborted();
              headerDeadline();
              return fetch(upstream, {
                method: req.method,
                redirect: 'manual',
                headers: providerHeaders(account, req.headers),
                body,
                signal: abort.signal,
              });
            };
            const tried = new Set<string>();
            let response: Response, errorBody: string | null;
            for (;;) {
              tried.add(account.key);
              response = await send();
              if (response.status === 401) {
                await response.body?.cancel();
                account = await accessAccount(
                  paths,
                  account.key,
                  env,
                  account.credentials.generation,
                );
                response = await send();
                if (response.status === 401)
                  await rejectCredential(
                    paths,
                    account.key,
                    account.credentials.generation,
                  );
              }
              clearTimeout(headerTimer);
              idle();
              if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                throw new AccountError(
                  'upstream-redirect',
                  'Provider attempted an unexpected redirect',
                  502,
                );
              }
              errorBody = response.ok
                ? null
                : Buffer.from(
                    await readCapped(response, 256 * 1024, abort.signal),
                  ).toString();
              const quotaUntil =
                provider === 'codex' && errorBody !== null
                  ? quotaResetAt(errorBody, response)
                  : null;
              if (quotaUntil === null) break;
              await recordQuotaExhaustion(
                paths,
                account.key,
                model,
                quotaUntil,
              );
              // Cross-account retries require a self-contained request. Never replay a started stream,
              // account-local response reference, or generic rate throttle; cap account attempts at three.
              if (
                lease.pinned ||
                tried.size >= 3 ||
                path !== '/backend-api/codex/responses' ||
                !replayableRequest(payload)
              )
                break;
              const next = await rebalanceLease(
                paths,
                token,
                account.key,
                model,
                tried,
              );
              if (!next) break;
              account = await accessAccount(paths, next, env);
            }
            const headers = responseHeaders(response);
            if (errorBody !== null) {
              for (const sensitive of [
                token,
                account.credentials.access_token,
                account.credentials.refresh_token,
              ])
                if (sensitive)
                  errorBody = errorBody.split(sensitive).join('[redacted]');
              finish();
              return new Response(errorBody, {
                status: response.status,
                headers,
              });
            }
            buffered -= bytes;
            bytes = 0;
            body = undefined;
            payload = null;
            if (!response.body) {
              finish();
              return new Response(null, { status: response.status, headers });
            }
            responseReader = response.body.getReader();
            abort.signal.throwIfAborted();
            idle();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
              async pull(controller) {
                try {
                  const chunk = await responseReader!.read();
                  if (done) return;
                  if (chunk.done) {
                    finish();
                    controller.close();
                    responseReader!.releaseLock();
                  } else {
                    idle();
                    controller.enqueue(chunk.value);
                  }
                } catch (error) {
                  if (!done) {
                    finish();
                    controller.error(error);
                  }
                }
              },
              async cancel() {
                abort.abort();
                try {
                  await responseReader!.cancel();
                } finally {
                  finish();
                }
              },
            });
            return new Response(stream, { status: response.status, headers });
          } catch (error) {
            abort.abort();
            finish();
            throw error;
          }
        } catch (error) {
          return jsonError(error);
        }
      },
    });
    started = server;
    const endpoint: ServiceEndpoint = {
      schema_version: 1,
      port: server.port!,
      secret,
    };
    writePrivate(endpointFile(paths), endpoint);
    let stopPromise: Promise<void> | undefined;
    return {
      endpoint,
      server,
      activeRequests: () => active,
      bufferedBytes: () => buffered,
      stop(drainMs = 10_000): Promise<void> {
        stopPromise ??= (async () => {
          stopping = true;
          try {
            const deadline = Date.now() + drainMs;
            while (active > 0 && Date.now() < deadline) await Bun.sleep(20);
            for (const controller of controllers) controller.abort();
            await server.stop(true);
          } finally {
            release();
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    if (started) await started.stop(true);
    release();
    throw error;
  }
}
export async function readyEndpoint(
  paths: StatePaths,
): Promise<ServiceEndpoint> {
  const endpoint = readEndpoint(paths);
  if (!endpoint)
    throw new AccountError(
      'daemon-unavailable',
      'Start agentusage daemon run before launching managed accounts',
      503,
    );
  try {
    const response = await fetch(endpointURL(endpoint) + '/health', {
      headers: { authorization: `Bearer ${endpoint.secret}` },
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body = JSON.parse(
      Buffer.from(await readCapped(response, 4096)).toString(),
    );
    if (body.ok !== true || body.schema_version !== 1) throw new Error();
    return endpoint;
  } catch {
    throw new AccountError(
      'daemon-unavailable',
      'The agentusage daemon is unavailable; restart its AgentStart service',
      503,
    );
  }
}
