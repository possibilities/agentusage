/**
 * Claude observation sidecar — keeper's schema v7 shape, kept field-for-field
 * so the balance port stays faithful and old tooling can read the file.
 */

export const OBSERVATION_SCHEMA_VERSION = 7;

export interface NormalizedWindow {
  /** "session" | "week" | "spend" | `model:${name}` */
  key: string;
  /** cswap pct / 100; may exceed 1 when the provider reports over-limit. */
  utilization: number;
  resetsAt: string | null;
}

export type ClaudeSubscriptionType = "pro" | "max";
export type CapacityMultiplier = 1 | 5 | 20;

export interface AccountCapacityMetadata {
  subscriptionType?: ClaudeSubscriptionType;
  rateLimitMultiplier?: CapacityMultiplier;
}

export interface AccountUsageMeasurement {
  windows: NormalizedWindow[];
  measuredAtMs: number;
}

export type RouteKind = "managed";

export interface Route {
  id: string; // `claude-swap:${slot}`
  kind: RouteKind;
  slot: number;
  windows: NormalizedWindow[];
  measuredAtMs: number;
}

export type ObservationHealth = "ok" | "absent" | "stale" | "malformed" | "unsupported" | "error";

export type AccountObservationIssue =
  | "relogin-required"
  | "token-expired"
  | "keychain-unavailable"
  | "no-credentials"
  | "api-key"
  | "usage-unavailable"
  | "account-unavailable"
  | "missing-freshness"
  | "missing-windows"
  | "malformed-scoped-windows";

export interface ClaudeAccountDisplay {
  count: number;
  /** Managed route id → zero-based position in cswap inventory order. */
  ordinals: Record<string, number>;
}

export interface Observation {
  schema_version: number;
  observed_at_ms: number;
  health: ObservationHealth;
  /** Only launch-eligible accounts. Every account is here XOR in issues. */
  routes: Route[];
  claude_accounts: ClaudeAccountDisplay;
  account_capacity?: Record<string, AccountCapacityMetadata>;
  /** Display-grade windows for every account that has any, issues included. */
  account_measurements?: Record<string, AccountUsageMeasurement>;
  account_issues: Record<string, AccountObservationIssue>;
  notes: string[];
}

export const SESSION_WINDOW = "session";
export const WEEK_WINDOW = "week";
export const SPEND_WINDOW = "spend";
export const MODEL_WINDOW_PREFIX = "model:";
export const FABLE_WINDOW_KEY = "model:fable";

export function routeIdForSlot(slot: number): string {
  return `claude-swap:${slot}`;
}

/** Operator-facing name for a route: `claude-<slot>`, 1-indexed like cswap's own numbering. */
export function displayNameForRouteId(id: string): string {
  const slot = slotForRouteId(id);
  return slot === null ? id : `claude-${slot}`;
}

export function slotForRouteId(id: string): number | null {
  const match = /^claude-swap:([1-9]\d*)$/u.exec(id);
  if (match === null) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) ? slot : null;
}

function isNormalizedWindow(value: unknown): value is NormalizedWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.key === "string" &&
    window.key.length > 0 &&
    typeof window.utilization === "number" &&
    Number.isFinite(window.utilization) &&
    window.utilization >= 0 &&
    (window.resetsAt === null || typeof window.resetsAt === "string")
  );
}

function isMeasurement(value: unknown): value is AccountUsageMeasurement {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    Array.isArray(m.windows) &&
    m.windows.every(isNormalizedWindow) &&
    typeof m.measuredAtMs === "number" &&
    Number.isFinite(m.measuredAtMs)
  );
}

const HEALTHS: readonly ObservationHealth[] = ["ok", "absent", "stale", "malformed", "unsupported", "error"];
const ISSUES: readonly AccountObservationIssue[] = [
  "relogin-required",
  "token-expired",
  "keychain-unavailable",
  "no-credentials",
  "api-key",
  "usage-unavailable",
  "account-unavailable",
  "missing-freshness",
  "missing-windows",
  "malformed-scoped-windows",
];

/**
 * Structural validation plus the load-bearing invariant: every observed
 * account is in exactly one of `routes` or `account_issues`, and a route
 * carries both binding windows. Returns null on any violation.
 */
export function validateObservation(value: unknown): Observation | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== OBSERVATION_SCHEMA_VERSION) return null;
  if (typeof raw.observed_at_ms !== "number" || !Number.isFinite(raw.observed_at_ms)) return null;
  if (!HEALTHS.includes(raw.health as ObservationHealth)) return null;
  if (!Array.isArray(raw.routes)) return null;
  if (typeof raw.account_issues !== "object" || raw.account_issues === null) return null;
  const issues = raw.account_issues as Record<string, unknown>;
  for (const issue of Object.values(issues)) {
    if (!ISSUES.includes(issue as AccountObservationIssue)) return null;
  }
  const display = raw.claude_accounts as Record<string, unknown> | null;
  if (typeof display !== "object" || display === null) return null;
  if (typeof display.count !== "number" || !Number.isSafeInteger(display.count) || display.count < 0) return null;
  if (typeof display.ordinals !== "object" || display.ordinals === null) return null;
  if (!Array.isArray(raw.notes) || !raw.notes.every((note) => typeof note === "string")) return null;

  const seen = new Set<string>();
  for (const candidate of raw.routes) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const route = candidate as Record<string, unknown>;
    if (route.kind !== "managed") return null;
    if (typeof route.id !== "string" || slotForRouteId(route.id) === null) return null;
    if (typeof route.slot !== "number" || slotForRouteId(route.id) !== route.slot) return null;
    if (typeof route.measuredAtMs !== "number" || !Number.isFinite(route.measuredAtMs)) return null;
    if (!Array.isArray(route.windows) || !route.windows.every(isNormalizedWindow)) return null;
    const keys = route.windows.map((window) => (window as NormalizedWindow).key);
    if (!keys.includes(SESSION_WINDOW) || !keys.includes(WEEK_WINDOW)) return null;
    if (seen.has(route.id)) return null;
    seen.add(route.id);
    if (route.id in issues) return null;
  }
  for (const id of Object.keys(issues)) {
    if (seen.has(id)) return null;
    seen.add(id);
  }
  if (raw.account_measurements !== undefined) {
    if (typeof raw.account_measurements !== "object" || raw.account_measurements === null) return null;
    for (const measurement of Object.values(raw.account_measurements as Record<string, unknown>)) {
      if (!isMeasurement(measurement)) return null;
    }
  }
  return value as Observation;
}
