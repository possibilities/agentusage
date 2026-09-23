import type { ObservationHealth } from "../claude/types.ts";

export const DEVIN_OBSERVATION_SCHEMA_VERSION = 1;

/**
 * One Devin CLI login's account-level quota reading. Not a managed account:
 * no balance, focus, prepare, or lease applies to it.
 */
export interface DevinUsage {
  planLabel: string | null;
  /** "quota" | "acu" | "credits", normalized from the provider billing strategy. */
  billing: string | null;
  dailyRemainingPercent: number | null;
  weeklyRemainingPercent: number | null;
  dailyResetsAt: string | null;
  weeklyResetsAt: string | null;
  /** Billing cycle bounds (the provider's planStart/planEnd). */
  periodStart: string | null;
  periodEnd: string | null;
  /** -1 means the plan carries no finite monthly credit allotment. */
  promptCreditsMonthly: number | null;
  promptCreditsAvailable: number | null;
  weeklyQuotaHidden: boolean | null;
  displayName: string | null;
}

export interface DevinObservation {
  schema_version: number;
  source_revision?: number;
  observed_at_ms: number;
  health: ObservationHealth;
  usage: DevinUsage | null;
  stale: boolean;
  error: { code: string | null; message: string } | null;
  notes: string[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentOrNull(value: unknown): boolean {
  return value === null || (finite(value) && value >= 0 && value <= 100);
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function boolOrNull(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function intOrNull(value: unknown): boolean {
  return value === null || (finite(value) && Number.isSafeInteger(value));
}

function validUsage(value: unknown): value is DevinUsage | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    stringOrNull(row.planLabel) &&
    stringOrNull(row.billing) &&
    percentOrNull(row.dailyRemainingPercent) &&
    percentOrNull(row.weeklyRemainingPercent) &&
    stringOrNull(row.dailyResetsAt) &&
    stringOrNull(row.weeklyResetsAt) &&
    stringOrNull(row.periodStart) &&
    stringOrNull(row.periodEnd) &&
    intOrNull(row.promptCreditsMonthly) &&
    intOrNull(row.promptCreditsAvailable) &&
    boolOrNull(row.weeklyQuotaHidden) &&
    stringOrNull(row.displayName)
  );
}

const HEALTHS: readonly ObservationHealth[] = ["ok", "absent", "stale", "malformed", "unsupported", "error"];

export function validateDevinObservation(value: unknown): DevinObservation | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (root.schema_version !== DEVIN_OBSERVATION_SCHEMA_VERSION) return null;
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
  return value as DevinObservation;
}
