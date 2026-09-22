import type { ObservationHealth } from "../claude/types.ts";

export const GROK_BOT_OBSERVATION_SCHEMA_VERSION = 1;

/** One account-level Grok Bot allowance. Not a managed Grok account. */
export interface GrokBotUsage {
  usedPercent: number;
  periodStart: string;
  resetsAt: string;
  hasAvailableUsage: boolean;
  planLabel: string | null;
  fundingPlan: string | null;
  onDemandEligible: boolean | null;
  onDemandEnabled: boolean | null;
  trial: boolean | null;
  teamSeat: boolean | null;
}

export interface GrokBotObservation {
  schema_version: number;
  source_revision?: number;
  observed_at_ms: number;
  health: ObservationHealth;
  usage: GrokBotUsage | null;
  stale: boolean;
  error: { code: string | null; message: string } | null;
  notes: string[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function boolOrNull(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function validUsage(value: unknown): value is GrokBotUsage | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    finite(row.usedPercent) &&
    row.usedPercent >= 0 &&
    row.usedPercent <= 100 &&
    typeof row.periodStart === "string" &&
    typeof row.resetsAt === "string" &&
    typeof row.hasAvailableUsage === "boolean" &&
    stringOrNull(row.planLabel) &&
    stringOrNull(row.fundingPlan) &&
    boolOrNull(row.onDemandEligible) &&
    boolOrNull(row.onDemandEnabled) &&
    boolOrNull(row.trial) &&
    boolOrNull(row.teamSeat)
  );
}

const HEALTHS: readonly ObservationHealth[] = ["ok", "absent", "stale", "malformed", "unsupported", "error"];

export function validateGrokBotObservation(value: unknown): GrokBotObservation | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (root.schema_version !== GROK_BOT_OBSERVATION_SCHEMA_VERSION) return null;
  if (
    root.source_revision !== undefined &&
    (!Number.isSafeInteger(root.source_revision) || Number(root.source_revision) < 1)
  ) return null;
  if (!finite(root.observed_at_ms)) return null;
  if (!HEALTHS.includes(root.health as ObservationHealth)) return null;
  if (!validUsage(root.usage) || typeof root.stale !== "boolean") return null;
  if (!Array.isArray(root.notes) || !root.notes.every((note) => typeof note === "string")) return null;
  if (root.error !== null) {
    if (typeof root.error !== "object" || root.error === null) return null;
    const error = root.error as Record<string, unknown>;
    if (!stringOrNull(error.code) || typeof error.message !== "string") return null;
  }
  return value as GrokBotObservation;
}
