import { MAX_CSWAP_ACCOUNTS, MAX_OUTPUT_BYTES, SUBPROCESS_TIMEOUT_MS } from "../constants.ts";
import { cswapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";
import {
  type AccountCapacityMetadata,
  type AccountObservationIssue,
  type AccountUsageMeasurement,
  type NormalizedWindow,
  OBSERVATION_SCHEMA_VERSION,
  type Observation,
  type Route,
  routeIdForSlot,
  SESSION_WINDOW,
  WEEK_WINDOW,
} from "./types.ts";

const SCOPED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+:/()-]*$/u;
const SCOPED_NAME_MAX_LENGTH = 64;

/** Accepts only timezone-bearing timestamps; a naive local time is ambiguous. */
function parseUtcMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseWindow(key: string, value: unknown): NormalizedWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const window = value as Record<string, unknown>;
  if (typeof window.pct !== "number" || !Number.isFinite(window.pct)) return null;
  const utilization = Math.max(0, window.pct / 100);
  const resetsAt = parseUtcMs(window.resetsAt);
  return { key, utilization, resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString() };
}

interface ParsedWindows {
  windows: NormalizedWindow[];
  malformedScoped: boolean;
}

function parseUsageWindows(usage: Record<string, unknown>): ParsedWindows {
  const windows: NormalizedWindow[] = [];
  const session = parseWindow(SESSION_WINDOW, usage.fiveHour);
  if (session !== null) windows.push(session);
  const week = parseWindow(WEEK_WINDOW, usage.sevenDay);
  if (week !== null) windows.push(week);
  const spend = parseWindow("spend", usage.spend);
  if (spend !== null) windows.push(spend);

  let malformedScoped = false;
  if (usage.scoped !== undefined) {
    if (!Array.isArray(usage.scoped)) {
      malformedScoped = true;
    } else {
      const seenNames = new Set<string>();
      for (const entry of usage.scoped) {
        if (typeof entry !== "object" || entry === null) {
          malformedScoped = true;
          break;
        }
        const scoped = entry as Record<string, unknown>;
        const name = scoped.name;
        if (
          typeof name !== "string" ||
          name.length === 0 ||
          name.length > SCOPED_NAME_MAX_LENGTH ||
          !SCOPED_NAME_PATTERN.test(name) ||
          seenNames.has(name.toLowerCase())
        ) {
          malformedScoped = true;
          break;
        }
        seenNames.add(name.toLowerCase());
        const window = parseWindow(`model:${name.toLowerCase()}`, scoped);
        if (window === null) {
          malformedScoped = true;
          break;
        }
        windows.push(window);
      }
    }
  }
  return { windows, malformedScoped };
}

const STATUS_ISSUES: Record<string, AccountObservationIssue> = {
  relogin_required: "relogin-required",
  token_expired: "token-expired",
  keychain_unavailable: "keychain-unavailable",
  no_credentials: "no-credentials",
  api_key: "api-key",
  unavailable: "usage-unavailable",
};

function parseCapacity(row: Record<string, unknown>): AccountCapacityMetadata | null {
  const capacity: AccountCapacityMetadata = {};
  if (row.subscriptionType === "pro" || row.subscriptionType === "max") {
    capacity.subscriptionType = row.subscriptionType;
  }
  if (row.rateLimitMultiplier === 1 || row.rateLimitMultiplier === 5 || row.rateLimitMultiplier === 20) {
    capacity.rateLimitMultiplier = row.rateLimitMultiplier;
  }
  return Object.keys(capacity).length > 0 ? capacity : null;
}

function emptyObservation(nowMs: number, health: Observation["health"], notes: string[]): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health,
    routes: [],
    claude_accounts: { count: 0, ordinals: {} },
    account_issues: {},
    notes,
  };
}

/** Builds the observation from an already-parsed `cswap list --json` payload. */
export function buildObservation(payload: unknown, nowMs: number): Observation {
  if (typeof payload !== "object" || payload === null) {
    return emptyObservation(nowMs, "malformed", ["cswap payload is not an object"]);
  }
  const root = payload as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    return emptyObservation(nowMs, "unsupported", [`cswap schemaVersion ${String(root.schemaVersion)}`]);
  }
  if (!Array.isArray(root.accounts)) {
    return emptyObservation(nowMs, "malformed", ["cswap accounts is not an array"]);
  }

  const notes: string[] = [];
  let rows = root.accounts;
  if (rows.length > MAX_CSWAP_ACCOUNTS) {
    notes.push(`cswap reported ${rows.length} accounts; keeping the first ${MAX_CSWAP_ACCOUNTS}`);
    rows = rows.slice(0, MAX_CSWAP_ACCOUNTS);
  }

  const routes: Route[] = [];
  const ordinals: Record<string, number> = {};
  const issues: Record<string, AccountObservationIssue> = {};
  const capacity: Record<string, AccountCapacityMetadata> = {};
  const measurements: Record<string, AccountUsageMeasurement> = {};
  let ordinal = 0;

  for (const candidate of rows) {
    if (typeof candidate !== "object" || candidate === null) {
      notes.push("dropped a non-object account row");
      continue;
    }
    const row = candidate as Record<string, unknown>;
    const slot = row.number;
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
      notes.push("dropped an account row without a positive slot number");
      continue;
    }
    const id = routeIdForSlot(slot);
    if (id in issues || routes.some((route) => route.id === id)) {
      notes.push(`dropped duplicate account row for ${id}`);
      continue;
    }
    ordinals[id] = ordinal;
    ordinal += 1;

    const rowCapacity = parseCapacity(row);
    if (rowCapacity !== null) capacity[id] = rowCapacity;

    const record = (issue: AccountObservationIssue): void => {
      issues[id] = issue;
      const lastGood = row.lastGoodUsage;
      if (typeof lastGood === "object" && lastGood !== null) {
        const parsed = parseUsageWindows(lastGood as Record<string, unknown>);
        const measuredAtMs =
          parseUtcMs(row.lastGoodFetchedAt) ??
          (typeof row.lastGoodAgeSeconds === "number" && Number.isFinite(row.lastGoodAgeSeconds)
            ? nowMs - row.lastGoodAgeSeconds * 1000
            : null);
        if (!parsed.malformedScoped && parsed.windows.length > 0 && measuredAtMs !== null) {
          measurements[id] = { windows: parsed.windows, measuredAtMs };
        }
      }
    };

    const status = row.usageStatus;
    if (status !== "ok") {
      record(typeof status === "string" && status in STATUS_ISSUES ? STATUS_ISSUES[status]! : "account-unavailable");
      continue;
    }
    const usage = row.usage;
    if (typeof usage !== "object" || usage === null) {
      record("usage-unavailable");
      continue;
    }
    const measuredAtMs =
      parseUtcMs(row.usageFetchedAt) ??
      (typeof row.usageAgeSeconds === "number" && Number.isFinite(row.usageAgeSeconds) && row.usageAgeSeconds >= 0
        ? nowMs - row.usageAgeSeconds * 1000
        : null);
    if (measuredAtMs === null) {
      record("missing-freshness");
      continue;
    }
    const parsed = parseUsageWindows(usage as Record<string, unknown>);
    if (parsed.malformedScoped) {
      record("malformed-scoped-windows");
      continue;
    }
    const keys = parsed.windows.map((window) => window.key);
    if (!keys.includes(SESSION_WINDOW) || !keys.includes(WEEK_WINDOW)) {
      issues[id] = "missing-windows";
      if (parsed.windows.length > 0) measurements[id] = { windows: parsed.windows, measuredAtMs };
      continue;
    }
    routes.push({ id, kind: "managed", slot, windows: parsed.windows, measuredAtMs });
    measurements[id] = { windows: parsed.windows, measuredAtMs };
  }

  const observation: Observation = {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health: "ok",
    routes,
    claude_accounts: { count: ordinal, ordinals },
    account_issues: issues,
    notes,
  };
  if (Object.keys(capacity).length > 0) observation.account_capacity = capacity;
  if (Object.keys(measurements).length > 0) observation.account_measurements = measurements;
  return observation;
}

/** Runs `cswap list --json` and normalizes the outcome into an Observation. */
export async function observeClaude(env: Record<string, string | undefined> = process.env): Promise<Observation> {
  const nowMs = Date.now();
  const argv = [...cswapArgv(env), "list", "--json"];
  const run = await runBounded(argv, { timeoutMs: SUBPROCESS_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  if (run.error === "spawn-failed") {
    return emptyObservation(nowMs, run.enoent ? "absent" : "error", [
      run.enoent ? `cswap binary not found (${argv[0]})` : "cswap spawn failed",
    ]);
  }
  if (run.error === "timeout") return emptyObservation(nowMs, "error", ["cswap list timed out"]);
  if (run.error === "output-cap") return emptyObservation(nowMs, "error", ["cswap list output exceeded cap"]);
  if (run.code !== 0) {
    const detail = run.stderr.trim().split("\n").at(-1) ?? "";
    return emptyObservation(nowMs, "error", [`cswap list exited ${run.code}${detail ? `: ${detail.slice(0, 200)}` : ""}`]);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    return emptyObservation(nowMs, "malformed", ["cswap list emitted invalid JSON"]);
  }
  return buildObservation(payload, nowMs);
}
