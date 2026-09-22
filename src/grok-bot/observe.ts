import { MAX_OUTPUT_BYTES, SUBPROCESS_TIMEOUT_MS } from "../constants.ts";
import type { ObservationHealth } from "../claude/types.ts";
import { runBounded, type RunResult } from "../proc.ts";
import {
  GROK_BOT_OBSERVATION_SCHEMA_VERSION,
  type GrokBotObservation,
  type GrokBotUsage,
} from "./types.ts";

const LABEL = /^[\w .+-]{1,80}$/;
const PLAN = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;

export interface ObserveGrokBotOptions {
  env?: Record<string, string | undefined>;
  nowMs?: number;
  previous?: GrokBotObservation | null;
  run?: (argv: readonly string[]) => Promise<RunResult>;
}

interface Attempt {
  health: ObservationHealth;
  usage: GrokBotUsage | null;
  error: { code: string | null; message: string } | null;
  notes: string[];
}

function blank(nowMs: number, attempt: Attempt, stale: boolean): GrokBotObservation {
  return {
    schema_version: GROK_BOT_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health: attempt.health,
    usage: attempt.usage,
    stale,
    error: attempt.error,
    notes: attempt.notes,
  };
}

function retain(nowMs: number, previous: GrokBotObservation | null | undefined, attempt: Attempt): GrokBotObservation {
  if (previous?.usage == null) return blank(nowMs, attempt, false);
  return blank(nowMs, { ...attempt, health: attempt.health === "ok" ? "ok" : "stale", usage: previous.usage }, true);
}

function label(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("://")) return null;
  return value;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Allowlisted hub fields only. URLs, account ids, and unknown strings are dropped. */
export function usageFromHub(value: unknown): GrokBotUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const used = row.usagePercent;
  const start = row.currentPeriodStartMs;
  const reset = row.nextResetAtMs;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof start !== "number" || !Number.isFinite(start) || start <= 0) return null;
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) return null;
  const periodStart = new Date(start).toISOString();
  const resetsAt = new Date(reset).toISOString();
  if (!Number.isFinite(Date.parse(periodStart)) || !Number.isFinite(Date.parse(resetsAt))) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    periodStart,
    resetsAt,
    hasAvailableUsage: row.hasAvailableUsage !== false,
    planLabel: label(row.planLabel, LABEL),
    fundingPlan: label(row.fundingPlan, PLAN),
    onDemandEligible: flag(row.onDemandEligible),
    onDemandEnabled: flag(row.onDemandEnabled),
    trial: flag(row.trial),
    teamSeat: flag(row.isTeamSeat),
  };
}

function fixedFailure(code: string): Attempt {
  switch (code) {
    case "command_rejected":
      return { health: "unsupported", usage: null, error: { code, message: "Grok Bot usage is not enabled for this login" }, notes: [] };
    case "not_authenticated":
    case "token_refresh_failed":
    case "hub_rejected":
      return { health: "error", usage: null, error: { code, message: "Grok Bot login is unavailable" }, notes: [] };
    case "no_plan":
      return { health: "error", usage: null, error: { code, message: "This login has no Grok Bot plan" }, notes: [] };
    case "usage_exhausted":
      return {
        health: "ok",
        usage: null,
        error: { code, message: "Grok Bot usage is spent for this period" },
        notes: ["Grok Bot usage is spent for this period"],
      };
    case "hub_unreachable":
    case "hub_timeout":
      return { health: "error", usage: null, error: { code, message: "The Grok Bot hub could not be reached" }, notes: [] };
    default:
      return { health: "error", usage: null, error: { code: "upstream_error", message: "Grok Bot usage could not be read" }, notes: [] };
  }
}

export function attemptFromStdout(stdout: string): Attempt {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { return { health: "malformed", usage: null, error: { code: "malformed", message: "Grok Bot usage response was not usable" }, notes: [] }; }
  if (typeof parsed !== "object" || parsed === null) {
    return { health: "malformed", usage: null, error: { code: "malformed", message: "Grok Bot usage response was not usable" }, notes: [] };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schema_version !== 1 || typeof envelope.ok !== "boolean") {
    return { health: "malformed", usage: null, error: { code: "malformed", message: "Grok Bot usage response was not usable" }, notes: [] };
  }
  if (envelope.ok === true) {
    const data = envelope.data;
    const usage = typeof data === "object" && data !== null ? usageFromHub((data as Record<string, unknown>).usage) : null;
    if (usage === null) {
      return { health: "malformed", usage: null, error: { code: "malformed", message: "Grok Bot usage response was not usable" }, notes: [] };
    }
    return { health: "ok", usage, error: null, notes: [] };
  }
  const error = envelope.error;
  const code = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).code === "string"
    ? (error as Record<string, unknown>).code as string
    : "upstream_error";
  return fixedFailure(code);
}

function attemptFromRun(result: RunResult): Attempt {
  if (result.error === "timeout") {
    return { health: "error", usage: null, error: { code: "timeout", message: "Grok Bot usage timed out" }, notes: [] };
  }
  if (result.error === "output-cap") {
    return { health: "malformed", usage: null, error: { code: "output-cap", message: "Grok Bot usage response was too large" }, notes: [] };
  }
  if (result.error === "spawn-failed" || result.enoent) {
    return {
      health: "error",
      usage: null,
      error: {
        code: result.enoent ? "not_installed" : "spawn_failed",
        message: result.enoent ? "agentgrok is not installed" : "agentgrok could not be started",
      },
      notes: [],
    };
  }
  if (result.stdout.trim().length === 0) {
    return { health: "error", usage: null, error: { code: "empty", message: "Grok Bot usage could not be read" }, notes: [] };
  }
  return attemptFromStdout(result.stdout);
}

export function grokBotCommand(env: Record<string, string | undefined>): string {
  const override = env.AGENTUSAGE_GROK_BOT_BIN;
  if (override !== undefined && override.length > 0) {
    if (override.includes("\0") || override.startsWith("-")) throw new Error("Grok Bot observer command is not a path");
    return override;
  }
  return "agentgrok";
}

export async function observeGrokBot(options: ObserveGrokBotOptions = {}): Promise<GrokBotObservation> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  let result: RunResult;
  try {
    const argv = [grokBotCommand(env), "usage", "--json"] as const;
    result = options.run
      ? await options.run(argv)
      : await runBounded(argv, { timeoutMs: SUBPROCESS_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  } catch {
    result = { ok: false, code: null, stdout: "", stderr: "", error: "spawn-failed", enoent: false };
  }
  const attempt = attemptFromRun(result);
  if (attempt.health === "ok" && attempt.usage !== null) return blank(nowMs, attempt, false);
  if (attempt.error?.code === "usage_exhausted") return retain(nowMs, options.previous, attempt);
  return retain(nowMs, options.previous, attempt);
}
