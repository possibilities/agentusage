import type { ObservationHealth } from "../claude/types.ts";

export const GROK_OBSERVATION_SCHEMA_VERSION = 1;

export type GrokAuthStatus = "valid" | "expired" | "missing" | "error";
export type GrokBillingStatus = "fresh" | "stale" | "unknown" | "error";

export interface GrokIncludedUsage {
  usedPercent: number | null;
  remainingPercent: number | null;
  periodType: string | null;
  periodStart: string | null;
  resetsAt: string | null;
}

export interface GrokPrepaidUsage {
  balanceUsd: number | null;
}

export interface GrokPaygUsage {
  enabled: boolean | null;
  usedUsd: number | null;
  capUsd: number | null;
  remainingUsd: number | null;
}

export interface GrokAccountView {
  accountKey: string;
  displayName: string;
  ordinal: number;
  alias: string | null;
  email: string | null;
  enabled: boolean;
  authStatus: GrokAuthStatus;
  expiresAt: string | null;
  billingStatus: GrokBillingStatus;
  included: GrokIncludedUsage | null;
  prepaid: GrokPrepaidUsage | null;
  payg: GrokPaygUsage | null;
  subscriptionTier: string | null;
  observedAtMs: number | null;
  lastGoodAtMs: number | null;
  stale: boolean;
  error: { code: string | null; message: string } | null;
}

export interface GrokObservation {
  schema_version: number;
  observed_at_ms: number;
  health: ObservationHealth;
  dependency: { name: "grok-swap"; healthy: boolean } | null;
  accounts: GrokAccountView[];
  notes: string[];
}

function finiteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validIncluded(value: unknown): value is GrokIncludedUsage | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    finiteOrNull(row.usedPercent) &&
    finiteOrNull(row.remainingPercent) &&
    stringOrNull(row.periodType) &&
    stringOrNull(row.periodStart) &&
    stringOrNull(row.resetsAt)
  );
}

function validPrepaid(value: unknown): value is GrokPrepaidUsage | null {
  return value === null || (typeof value === "object" && finiteOrNull((value as Record<string, unknown>).balanceUsd));
}

function validPayg(value: unknown): value is GrokPaygUsage | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.enabled === null || typeof row.enabled === "boolean") &&
    finiteOrNull(row.usedUsd) &&
    finiteOrNull(row.capUsd) &&
    finiteOrNull(row.remainingUsd)
  );
}

const AUTH_STATUSES: readonly GrokAuthStatus[] = ["valid", "expired", "missing", "error"];
const BILLING_STATUSES: readonly GrokBillingStatus[] = ["fresh", "stale", "unknown", "error"];
const HEALTHS: readonly ObservationHealth[] = ["ok", "absent", "stale", "malformed", "unsupported", "error"];

export function validateGrokObservation(value: unknown): GrokObservation | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (root.schema_version !== GROK_OBSERVATION_SCHEMA_VERSION) return null;
  if (typeof root.observed_at_ms !== "number" || !Number.isFinite(root.observed_at_ms)) return null;
  if (!HEALTHS.includes(root.health as ObservationHealth)) return null;
  if (!Array.isArray(root.accounts) || !Array.isArray(root.notes)) return null;
  if (!root.notes.every((note) => typeof note === "string")) return null;
  for (const candidate of root.accounts) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const account = candidate as Record<string, unknown>;
    if (typeof account.accountKey !== "string" || account.accountKey.length === 0) return null;
    if (typeof account.displayName !== "string" || account.displayName.length === 0) return null;
    if (typeof account.ordinal !== "number" || !Number.isSafeInteger(account.ordinal) || account.ordinal < 1) return null;
    if (!stringOrNull(account.alias) || !stringOrNull(account.email) || !stringOrNull(account.expiresAt)) return null;
    if (typeof account.enabled !== "boolean") return null;
    if (!AUTH_STATUSES.includes(account.authStatus as GrokAuthStatus)) return null;
    if (!BILLING_STATUSES.includes(account.billingStatus as GrokBillingStatus)) return null;
    if (!validIncluded(account.included) || !validPrepaid(account.prepaid) || !validPayg(account.payg)) return null;
    if (!stringOrNull(account.subscriptionTier)) return null;
    if (!finiteOrNull(account.observedAtMs) || !finiteOrNull(account.lastGoodAtMs)) return null;
    if (typeof account.stale !== "boolean") return null;
    if (account.error !== null) {
      if (typeof account.error !== "object") return null;
      const error = account.error as Record<string, unknown>;
      if (!stringOrNull(error.code) || typeof error.message !== "string") return null;
    }
  }
  return value as GrokObservation;
}

export function grokAccountEligible(account: GrokAccountView, allowUnknown = false): boolean {
  if (!account.enabled || account.authStatus !== "valid") return false;
  if (account.billingStatus === "fresh" || account.billingStatus === "stale") return true;
  return allowUnknown && account.billingStatus === "unknown";
}
