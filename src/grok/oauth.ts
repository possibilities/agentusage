import type { Credentials } from "./model.ts";
import { GrokError } from "./model.ts";
import { jsonBody, providerURL, type Env } from "../accounts/http.ts";
import { nonempty } from "../accounts/storage.ts";

export const XAI_ISSUER = "https://auth.x.ai";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// Retained from the Grok Build/Fx compatibility contract used by this provider.
// Billing ownership does not require conversation or workspace scopes.
export const XAI_SCOPES = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"] as const;
export const XAI_COMPAT_VERSION = "1.0.16";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_LOGIN_MS = 15 * 60_000;

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}
interface TokenSet { accessToken: string; refreshToken: string | null; expiresIn: number }
export interface LoginResult { credentials: Credentials; userId: string; email: string | null }
export interface LoginOptions {
  openBrowser: boolean;
  onPrompt: (prompt: { verificationUri: string; userCode: string; expiresIn: number }) => void;
  env?: Env;
}

const oauthHeaders = (surface = "cli") => ({
  "content-type": "application/x-www-form-urlencoded",
  "x-grok-client-version": XAI_COMPAT_VERSION,
  "x-grok-client-surface": surface,
});

export function providerSignal(deadlineMs?: number): AbortSignal {
  const remaining = deadlineMs === undefined ? 15_000 : Math.min(15_000, deadlineMs - Date.now());
  if (remaining <= 0) throw new GrokError("observation_timeout", "The Grok refresh time budget was reached");
  return AbortSignal.timeout(Math.ceil(remaining));
}

async function request(path: string, init: RequestInit, env: Env, code: string, deadlineMs?: number): Promise<Response> {
  // Production origins are fixed. Fixture endpoints require an isolated state
  // root and IPv4 loopback; stored credentials never choose a network target.
  const url = providerURL("grok", path, env, true);
  const signal = providerSignal(deadlineMs);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal });
  } catch {
    throw new GrokError(code, "The xAI authentication service could not be reached");
  }
}
async function responseJson(response: Response, code: string): Promise<Record<string, unknown>> {
  try { return await jsonBody(response); }
  catch { throw new GrokError(code, "xAI returned an invalid or oversized response"); }
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const env = options.env ?? process.env;
  const device = await requestDeviceCode(env);
  options.onPrompt({ verificationUri: device.verificationUri, userCode: device.userCode, expiresIn: device.expiresIn });
  if (options.openBrowser) void openBrowser(device.verificationUriComplete ?? device.verificationUri);
  const token = await pollDeviceToken(device, env);
  if (!token.refreshToken) throw new GrokError("oauth_no_refresh_token", "xAI did not issue an offline refresh token; the account was not saved");
  const identity = await fetchIdentity(token.accessToken, env);
  return {
    credentials: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAtMs: Date.now() + token.expiresIn * 1000,
      issuer: XAI_ISSUER,
      clientId: XAI_CLIENT_ID,
    },
    userId: identity.userId,
    email: identity.email,
  };
}
async function requestDeviceCode(env: Env): Promise<DeviceCode> {
  const response = await request("/oauth2/device/code", {
    method: "POST", headers: oauthHeaders(),
    body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPES.join(" "), referrer: "grok-build" }),
  }, env, "oauth_device_request_failed");
  const body = await responseJson(response, "oauth_device_request_failed");
  if (!response.ok) throw oauthResponseError("oauth_device_request_failed", "xAI rejected the device authorization request", body);
  const userCode = requiredString(body, "user_code", "oauth_device_response_invalid");
  if (!/^[A-Za-z0-9-]+$/u.test(userCode)) throw new GrokError("oauth_device_response_invalid", "xAI returned an invalid device user code");
  const complete = optionalString(body, "verification_uri_complete");
  return {
    deviceCode: requiredString(body, "device_code", "oauth_device_response_invalid"),
    userCode,
    verificationUri: verificationUrl(requiredString(body, "verification_uri", "oauth_device_response_invalid"), env),
    verificationUriComplete: complete ? verificationUrl(complete, env) : null,
    expiresIn: Math.min(MAX_LOGIN_MS / 1000, positiveNumber(body, "expires_in", "oauth_device_response_invalid")),
    interval: Math.min(30, Math.max(1, Math.trunc(optionalNumber(body, "interval") ?? 5))),
  };
}
async function pollDeviceToken(device: DeviceCode, env: Env): Promise<TokenSet> {
  let intervalMs = device.interval * 1000;
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    const response = await request("/oauth2/token", {
      method: "POST", headers: oauthHeaders(),
      body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: device.deviceCode, client_id: XAI_CLIENT_ID }),
    }, env, "oauth_token_exchange_failed", deadline);
    const body = await responseJson(response, "oauth_token_exchange_failed");
    if (response.ok) return parseTokenSet(body, true);
    const code = body.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") { intervalMs = Math.min(30_000, intervalMs + 5_000); continue; }
    if (code === "access_denied") throw new GrokError("oauth_access_denied", "The xAI authorization request was denied");
    if (code === "expired_token") break;
    throw oauthResponseError("oauth_token_exchange_failed", "xAI rejected the token exchange", body);
  }
  throw new GrokError("oauth_device_expired", "The xAI device code expired before authorization completed");
}

export async function refreshCredentials(credentials: Credentials, expectedUserId: string, env: Env = process.env, deadlineMs?: number): Promise<{ credentials: Credentials; email: string | null }> {
  if (credentials.issuer !== XAI_ISSUER || credentials.clientId !== XAI_CLIENT_ID)
    throw new GrokError("auth_unavailable", "The stored OAuth issuer or client is not supported; sign in again");
  const response = await request("/oauth2/token", {
    method: "POST", headers: oauthHeaders("headless"),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: XAI_CLIENT_ID }),
  }, env, "oauth_refresh_failed", deadlineMs);
  const body = await responseJson(response, "oauth_refresh_failed");
  if (!response.ok) {
    if (body.error === "invalid_grant" || body.error === "invalid_client")
      throw new GrokError("auth_unavailable", "xAI rejected the saved session; sign in again");
    throw oauthResponseError("oauth_refresh_failed", "xAI rejected the credential refresh", body);
  }
  const token = parseTokenSet(body, false);
  const identity = await fetchIdentity(token.accessToken, env, deadlineMs);
  if (identity.userId !== expectedUserId)
    throw new GrokError("auth_unavailable", "Refreshed credentials resolved to a different xAI account; the rotation was discarded");
  return {
    credentials: { ...credentials, accessToken: token.accessToken, refreshToken: token.refreshToken ?? credentials.refreshToken, expiresAtMs: Date.now() + token.expiresIn * 1000 },
    email: identity.email,
  };
}
export function credentialsNeedRefresh(credentials: Credentials, now = Date.now()): boolean {
  return credentials.expiresAtMs <= now + 5 * 60_000;
}
async function fetchIdentity(accessToken: string, env: Env, deadlineMs?: number): Promise<{ userId: string; email: string | null }> {
  const response = await request("/oauth2/userinfo", {
    headers: { authorization: `Bearer ${accessToken}`, "x-grok-client-version": XAI_COMPAT_VERSION },
  }, env, "oauth_userinfo_failed", deadlineMs);
  const body = await responseJson(response, "oauth_userinfo_failed");
  if (!response.ok) throw new GrokError("oauth_userinfo_failed", "xAI rejected the authenticated identity lookup");
  const userId = requiredString(body, "sub", "oauth_userinfo_invalid");
  if (userId.length > 1024) throw new GrokError("oauth_userinfo_invalid", "xAI returned an unsafe account identity");
  return { userId, email: optionalString(body, "email") };
}
function parseTokenSet(body: Record<string, unknown>, requireRefresh: boolean): TokenSet {
  const refreshToken = optionalString(body, "refresh_token");
  if (requireRefresh && !refreshToken) throw new GrokError("oauth_no_refresh_token", "xAI did not return a refresh token");
  return { accessToken: requiredString(body, "access_token", "oauth_token_response_invalid"), refreshToken, expiresIn: positiveNumber(body, "expires_in", "oauth_token_response_invalid") };
}
async function openBrowser(url: string): Promise<void> {
  try { await Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exited; }
  catch { /* The human already received the verification URL and code. */ }
}
function verificationUrl(value: string, env: Env): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new GrokError("oauth_device_response_invalid", "xAI returned an invalid verification URL"); }
  const fixture = env.AGENTUSAGE_TEST_GROK_ORIGIN && url.origin === new URL(providerURL("grok", "/", env, true)).origin;
  const trusted = url.protocol === "https:" && !url.port && (url.hostname === "auth.x.ai" || url.hostname === "accounts.x.ai");
  if (url.username || url.password || (!fixture && !trusted)) throw new GrokError("oauth_device_response_invalid", "xAI returned an untrusted verification URL");
  return url.toString();
}
function requiredString(body: Record<string, unknown>, key: string, code: string): string {
  if (!nonempty(body[key])) throw new GrokError(code, `xAI response omitted a valid ${key}`);
  return body[key];
}
function optionalString(body: Record<string, unknown>, key: string): string | null {
  return nonempty(body[key]) ? body[key] : null;
}
function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positiveNumber(body: Record<string, unknown>, key: string, code: string): number {
  const value = optionalNumber(body, key);
  if (value === null || value <= 0 || value > 365 * 86400) throw new GrokError(code, `xAI response omitted a valid ${key}`);
  return value;
}
function oauthResponseError(code: string, message: string, body: Record<string, unknown>): GrokError {
  // Provider errors can reflect credentials. Only known protocol codes may
  // enter public diagnostics; descriptions and raw bodies are never retained.
  const known = ["invalid_grant", "invalid_client", "invalid_scope", "authorization_pending", "slow_down", "access_denied", "expired_token", "temporarily_unavailable"];
  const safeCode = typeof body.error === "string" && known.includes(body.error) ? body.error : null;
  return new GrokError(code, safeCode ? `${message} (${safeCode})` : message);
}
