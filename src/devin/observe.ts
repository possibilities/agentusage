import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ObservationHealth } from "../claude/types.ts";
import { jsonBody, type Env } from "../accounts/http.ts";
import { nonempty, record } from "../accounts/storage.ts";
import {
  DEVIN_OBSERVATION_SCHEMA_VERSION,
  type DevinObservation,
  type DevinUsage,
} from "./types.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const CREDENTIALS_MAX_BYTES = 64 * 1024;
const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
/** Client identity the seat-management endpoint requires, matching the installed CLI generation. */
const DEVIN_CLI_COMPAT = { ideName: "devin-cli", ideVersion: "3000.11.1", extensionName: "devin-cli", extensionVersion: "3000.11.1" } as const;

const LABEL = /^[\w .+-]{1,80}$/;
const BILLING: Record<string, string> = {
  BILLING_STRATEGY_QUOTA: "quota",
  BILLING_STRATEGY_ACU: "acu",
  BILLING_STRATEGY_CREDITS: "credits",
};

class DevinError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type DevinFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ObserveDevinOptions {
  env?: Env;
  nowMs?: number;
  previous?: DevinObservation | null;
  fetch?: DevinFetch;
}

interface Attempt {
  health: ObservationHealth;
  usage: DevinUsage | null;
  error: { code: string | null; message: string } | null;
  notes: string[];
}

function blank(nowMs: number, attempt: Attempt, stale: boolean): DevinObservation {
  return {
    schema_version: DEVIN_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health: attempt.health,
    usage: attempt.usage,
    stale,
    error: attempt.error,
    notes: attempt.notes,
  };
}

function retain(nowMs: number, previous: DevinObservation | null | undefined, attempt: Attempt): DevinObservation {
  if (previous?.usage == null) return blank(nowMs, attempt, false);
  return blank(nowMs, { ...attempt, health: attempt.health === "ok" ? "ok" : "stale", usage: previous.usage }, true);
}

/** The Devin CLI's own credential file; the card follows whichever login it holds. */
export function devinCredentialsPath(env: Env): string {
  const override = env.AGENTUSAGE_DEVIN_CREDENTIALS;
  if (override !== undefined && override.length > 0) {
    if (override.includes("\0")) throw new DevinError("credentials_path_invalid", "Devin credentials path is not usable");
    return override;
  }
  return join(homedir(), ".local", "share", "devin", "credentials.toml");
}

export function readDevinCredentials(path: string): { apiKey: string; apiServer: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DevinError("not_logged_in", "No Devin CLI login is installed");
    }
    throw new DevinError("credentials_unreadable", "Devin credentials could not be opened safely");
  }
  try {
    const st = fstatSync(fd);
    // The file stays in the native Devin home under vendor-chosen permissions;
    // it must still be the operator's own regular file, not a link or alias.
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      st.size > CREDENTIALS_MAX_BYTES
    ) {
      throw new DevinError("credentials_unsafe", "Devin credentials must be a regular file owned by you");
    }
    const text = readFileSync(fd, "utf8");
    let apiKey: string | null = null;
    let apiServer: string | null = null;
    for (const raw of text.split("\n")) {
      const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(raw.trim());
      if (pair === null) continue;
      const value = pair[2] ?? pair[3] ?? "";
      if (pair[1] === "windsurf_api_key") apiKey = value;
      else if (pair[1] === "api_server_url") apiServer = value;
    }
    if (apiKey === null || !nonempty(apiKey) || apiKey.length > 4096) {
      throw new DevinError("credentials_invalid", "Devin credentials do not carry an API key");
    }
    if (apiServer === null || !nonempty(apiServer)) {
      throw new DevinError("credentials_invalid", "Devin credentials do not carry an API server URL");
    }
    return { apiKey, apiServer };
  } finally {
    closeSync(fd);
  }
}

/** Fixed production path on the credential's own server; tests may pin an IPv4 loopback origin. */
export function devinServiceUrl(env: Env, apiServer: string): string {
  const testOrigin = env.AGENTUSAGE_TEST_DEVIN_ORIGIN;
  if (testOrigin !== undefined && testOrigin !== "") {
    const url = new URL(testOrigin);
    if (
      !env.AGENTUSAGE_STATE_ROOT ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new DevinError("invalid-test-origin", "Test endpoints require an isolated state root and an HTTP IPv4 loopback origin");
    }
    return new URL(STATUS_PATH, url).toString();
  }
  let base: URL;
  try {
    base = new URL(apiServer);
  } catch {
    throw new DevinError("credentials_invalid", "Devin credentials carry an unusable API server URL");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.hash) {
    throw new DevinError("credentials_invalid", "Devin credentials carry an unusable API server URL");
  }
  return new URL(STATUS_PATH, base).toString();
}

function label(value: unknown): string | null {
  if (typeof value !== "string" || !LABEL.test(value) || value.includes("://")) return null;
  return value;
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function quotaRemainingPercent(value: unknown, resetAt: string | null): number | null {
  // Proto3 JSON omits a zero-valued scalar. A reset time identifies an actual
  // quota window; without it, an absent percentage may mean unavailable data.
  return value === undefined && resetAt !== null ? 0 : percent(value);
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function epochIso(value: unknown): string | null {
  const seconds = integer(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Allowlisted seat-management fields only. URLs, ids, emails and unknown strings are dropped. */
export function usageFromStatus(value: unknown): DevinUsage | null {
  const root = record(value);
  const userStatus = record(root?.userStatus);
  const planStatus = record(userStatus?.planStatus);
  if (userStatus === null || planStatus === null) return null;
  const planInfo = record(planStatus.planInfo);
  const devinInfo = record(planInfo?.devinInfo);
  const strategy = planInfo?.billingStrategy;
  const dailyResetsAt = epochIso(planStatus.dailyQuotaResetAtUnix);
  const weeklyResetsAt = epochIso(planStatus.weeklyQuotaResetAtUnix);
  return {
    planLabel: label(planInfo?.planName),
    billing: typeof strategy === "string" ? (BILLING[strategy] ?? null) : null,
    dailyRemainingPercent: quotaRemainingPercent(planStatus.dailyQuotaRemainingPercent, dailyResetsAt),
    weeklyRemainingPercent: quotaRemainingPercent(planStatus.weeklyQuotaRemainingPercent, weeklyResetsAt),
    dailyResetsAt,
    weeklyResetsAt,
    periodStart: iso(planStatus.planStart),
    periodEnd: iso(planStatus.planEnd),
    promptCreditsMonthly: integer(planInfo?.monthlyPromptCredits),
    promptCreditsAvailable: integer(planStatus.availablePromptCredits),
    weeklyQuotaHidden: typeof planInfo?.hideWeeklyQuota === "boolean" ? planInfo.hideWeeklyQuota : null,
    displayName: label(devinInfo?.accountDisplayName),
  };
}

function attemptFailure(code: string): Attempt {
  const known: Record<string, { health: ObservationHealth; message: string }> = {
    not_logged_in: { health: "absent", message: "No Devin CLI login is installed" },
    credentials_unreadable: { health: "error", message: "Devin credentials could not be opened safely" },
    credentials_unsafe: { health: "error", message: "Devin credentials must be a regular file owned by you" },
    credentials_invalid: { health: "error", message: "Devin credentials are not usable" },
    credentials_path_invalid: { health: "error", message: "Devin credentials path is not usable" },
    auth_unavailable: { health: "error", message: "Devin rejected the CLI login credentials" },
    timeout: { health: "error", message: "Devin usage timed out" },
    rate_limited: { health: "error", message: "Devin usage is rate limited" },
    unavailable: { health: "error", message: "The Devin usage service could not be reached" },
    http_error: { health: "error", message: "The Devin usage request failed" },
    malformed: { health: "malformed", message: "Devin usage response was not usable" },
    "invalid-test-origin": { health: "error", message: "Devin test origin is not usable" },
  };
  const fixed = known[code] ?? { health: "error" as const, message: "Devin usage could not be read" };
  return {
    health: fixed.health,
    usage: null,
    error: { code: Object.hasOwn(known, code) ? code : "upstream_error", message: fixed.message },
    notes: [],
  };
}

const CONNECT_ERROR_CODES: Record<string, string> = {
  unauthenticated: "auth_unavailable",
  permission_denied: "auth_unavailable",
  invalid_argument: "auth_unavailable",
  resource_exhausted: "rate_limited",
  unavailable: "unavailable",
};

async function fetchStatus(apiKey: string, url: string, fetchImpl: DevinFetch): Promise<Attempt> {
  const body = JSON.stringify({
    metadata: { apiKey, ...DEVIN_CLI_COMPAT },
  });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return attemptFailure(timedOut ? "timeout" : "unavailable");
  }
  if (!response.ok) {
    let code: string | null = null;
    try {
      const parsed = await jsonBody(response);
      code = typeof parsed.code === "string" ? parsed.code : null;
    } catch {
      await response.body?.cancel().catch(() => {});
    }
    if (response.status === 401 || response.status === 403) return attemptFailure("auth_unavailable");
    if (response.status === 429) return attemptFailure("rate_limited");
    if (code !== null && Object.hasOwn(CONNECT_ERROR_CODES, code)) return attemptFailure(CONNECT_ERROR_CODES[code]!);
    return attemptFailure("http_error");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = await jsonBody(response);
  } catch {
    return attemptFailure("malformed");
  }
  const usage = usageFromStatus(parsed);
  if (usage === null) return attemptFailure("malformed");
  const notes: string[] = [];
  if (
    usage.dailyRemainingPercent === null &&
    usage.weeklyRemainingPercent === null &&
    usage.promptCreditsAvailable === null
  ) {
    notes.push("Devin reported no quota fields for this login");
  }
  return { health: "ok", usage, error: null, notes };
}

export async function observeDevin(options: ObserveDevinOptions = {}): Promise<DevinObservation> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  let attempt: Attempt;
  try {
    const credentials = readDevinCredentials(devinCredentialsPath(env));
    const url = devinServiceUrl(env, credentials.apiServer);
    attempt = await fetchStatus(credentials.apiKey, url, fetchImpl);
  } catch (error) {
    attempt = attemptFailure(error instanceof DevinError ? error.code : "upstream_error");
  }
  if (attempt.health === "ok" && attempt.usage !== null) return blank(nowMs, attempt, false);
  return retain(nowMs, options.previous, attempt);
}
