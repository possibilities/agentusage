import { MAX_OUTPUT_BYTES } from "../constants.ts";
import { grokSwapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";
import {
  GROK_OBSERVATION_SCHEMA_VERSION,
  type GrokAccountView,
  type GrokAuthStatus,
  type GrokBillingStatus,
  type GrokIncludedUsage,
  type GrokObservation,
  type GrokPaygUsage,
  type GrokPrepaidUsage,
} from "./types.ts";

const GROK_TIMEOUT_MS = 60_000;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function instantMs(value: unknown): number | null {
  const text = stringOrNull(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyGrokObservation(
  nowMs: number,
  health: GrokObservation["health"],
  notes: string[],
): GrokObservation {
  return {
    schema_version: GROK_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health,
    dependency: health === "absent" ? null : { name: "grok-swap", healthy: health === "ok" },
    accounts: [],
    notes,
  };
}

function includedUsage(value: unknown): GrokIncludedUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return {
    usedPercent: finiteOrNull(row.usedPercent),
    remainingPercent: finiteOrNull(row.remainingPercent),
    periodType: stringOrNull(row.periodType)?.toLowerCase().replace(/^usage_period_type_/u, "") ?? null,
    periodStart: stringOrNull(row.periodStart),
    resetsAt: stringOrNull(row.resetsAt),
  };
}

function prepaidUsage(value: unknown): GrokPrepaidUsage | null {
  if (typeof value !== "object" || value === null) return null;
  return { balanceUsd: finiteOrNull((value as Record<string, unknown>).balanceUsd) };
}

function paygUsage(value: unknown): GrokPaygUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : null,
    usedUsd: finiteOrNull(row.usedUsd),
    capUsd: finiteOrNull(row.capUsd),
    remainingUsd: finiteOrNull(row.remainingUsd),
  };
}

const AUTH_STATUSES: readonly GrokAuthStatus[] = ["valid", "expired", "missing", "error"];
const BILLING_STATUSES: readonly GrokBillingStatus[] = ["fresh", "stale", "unknown", "error"];

function parseAccount(value: unknown, notes: string[]): GrokAccountView | null {
  if (typeof value !== "object" || value === null) {
    notes.push("dropped a non-object grok account row");
    return null;
  }
  const row = value as Record<string, unknown>;
  const accountKey = stringOrNull(row.accountKey);
  const displayName = stringOrNull(row.displayName);
  const ordinal = finiteOrNull(row.ordinal);
  if (accountKey === null || displayName === null || ordinal === null || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    notes.push("dropped a grok account row without a valid identity");
    return null;
  }
  const authStatus = AUTH_STATUSES.includes(row.authStatus as GrokAuthStatus)
    ? (row.authStatus as GrokAuthStatus)
    : "error";
  const billingStatus = BILLING_STATUSES.includes(row.billingStatus as GrokBillingStatus)
    ? (row.billingStatus as GrokBillingStatus)
    : "unknown";
  const errorRaw = row.error;
  let error: GrokAccountView["error"] = null;
  if (typeof errorRaw === "string" && errorRaw.length > 0) error = { code: null, message: errorRaw };
  else if (typeof errorRaw === "object" && errorRaw !== null) {
    const errorRow = errorRaw as Record<string, unknown>;
    const message = stringOrNull(errorRow.message) ?? stringOrNull(errorRow.summary);
    if (message !== null) error = { code: stringOrNull(errorRow.code), message };
  }
  return {
    accountKey,
    displayName,
    ordinal,
    alias: stringOrNull(row.alias),
    email: stringOrNull(row.email),
    enabled: row.enabled === true,
    authStatus,
    expiresAt: stringOrNull(row.expiresAt),
    billingStatus,
    included: includedUsage(row.included),
    prepaid: prepaidUsage(row.prepaid),
    payg: paygUsage(row.payg),
    subscriptionTier: stringOrNull(row.subscriptionTier),
    observedAtMs: instantMs(row.observedAt),
    lastGoodAtMs: instantMs(row.lastGoodAt),
    stale: row.stale === true || billingStatus === "stale",
    error,
  };
}

export function buildGrokObservation(envelope: unknown, nowMs: number): GrokObservation {
  if (typeof envelope !== "object" || envelope === null) {
    return emptyGrokObservation(nowMs, "malformed", ["grok-swap envelope is not an object"]);
  }
  const root = envelope as Record<string, unknown>;
  if (root.schema_version !== 1) {
    return emptyGrokObservation(nowMs, "unsupported", [`grok-swap envelope schema_version ${String(root.schema_version)}`]);
  }
  if (root.ok !== true) {
    const error = (typeof root.error === "object" && root.error !== null ? root.error : {}) as Record<string, unknown>;
    const code = stringOrNull(error.code) ?? "unknown";
    const message = stringOrNull(error.message);
    return emptyGrokObservation(nowMs, "error", [`grok-swap error ${code}${message === null ? "" : `: ${message}`}`]);
  }
  if (root.provider !== "grok") {
    return emptyGrokObservation(nowMs, "malformed", ["grok-swap envelope has the wrong provider"]);
  }
  const data = (typeof root.data === "object" && root.data !== null ? root.data : {}) as Record<string, unknown>;
  if (!Array.isArray(data.accounts)) {
    return emptyGrokObservation(nowMs, "malformed", ["grok-swap envelope has no accounts array"]);
  }
  const notes: string[] = [];
  const accounts = data.accounts
    .map((account) => parseAccount(account, notes))
    .filter((account): account is GrokAccountView => account !== null)
    .sort((a, b) => a.ordinal - b.ordinal || a.accountKey.localeCompare(b.accountKey));
  return {
    schema_version: GROK_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health: "ok",
    dependency: { name: "grok-swap", healthy: true },
    accounts,
    notes,
  };
}

export interface ObserveGrokOptions {
  env?: Record<string, string | undefined>;
  refresh?: boolean;
  account?: string;
}

export async function observeGrok(options: ObserveGrokOptions = {}): Promise<GrokObservation> {
  const nowMs = Date.now();
  const env = options.env ?? process.env;
  const command = options.refresh === true ? "refresh" : "observe";
  const argv = [...grokSwapArgv(env), command, "--json"];
  if (command === "refresh" && options.account !== undefined) argv.push("--account", options.account);
  const run = await runBounded(argv, { timeoutMs: GROK_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  if (run.error === "spawn-failed") {
    return emptyGrokObservation(nowMs, run.enoent ? "absent" : "error", [
      run.enoent ? `grok-swap binary not found (${argv[0]})` : "grok-swap spawn failed",
    ]);
  }
  if (run.error === "timeout") return emptyGrokObservation(nowMs, "error", [`grok-swap ${command} timed out`]);
  if (run.error === "output-cap") {
    return emptyGrokObservation(nowMs, "error", [`grok-swap ${command} output exceeded cap`]);
  }
  let payload: unknown = null;
  if (run.stdout.trim().length > 0) {
    try {
      payload = JSON.parse(run.stdout);
    } catch {
      return emptyGrokObservation(nowMs, "malformed", [`grok-swap ${command} emitted invalid JSON`]);
    }
  }
  if (run.code !== 0 && payload === null) {
    const detail = run.stderr.trim().split("\n").at(-1) ?? "";
    return emptyGrokObservation(nowMs, "error", [
      `grok-swap ${command} exited ${run.code}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ]);
  }
  return buildGrokObservation(payload, nowMs);
}
