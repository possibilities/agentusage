import type { ObservationHealth } from "../claude/types.ts";

/**
 * Codex observation sidecar (agentusage schema v1), built from codex-swap's
 * `snapshot --json` contract (pinned at codex-swap f193bc1; all drift since
 * efce453 is additive). Windows are regrouped into lanes so independent quota
 * pools — most importantly gpt-5.3-codex-spark — render and balance as units.
 */

export const CODEX_OBSERVATION_SCHEMA_VERSION = 1;

export type CodexWindowRole = "primary" | "secondary" | "code_review" | "other";

export interface CodexLaneWindow {
  role: CodexWindowRole;
  /** Provider/duration label: "5h", "weekly", or the lane's own naming. */
  label: string;
  windowSeconds: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetAfterSeconds: number | null;
  limitName: string | null;
  meteredFeature: string | null;
}

export interface CodexLane {
  /** "main" | "codex-spark" | "code-review" | "codex-<slug>" | "codex-extra" */
  id: string;
  title: string;
  /** Only the main lane binds eligibility/headroom; spark never does. */
  binding: boolean;
  windows: CodexLaneWindow[];
}

export const SPARK_LANE_ID = "codex-spark";
export const MAIN_LANE_ID = "main";

export type CodexUsageStatus = "ok" | "stale" | "unknown" | "error" | "backoff" | "quarantined";

export interface CodexAccountView {
  accountKey: string;
  email: string | null;
  label: string | null;
  ndyIndex: number | null;
  enabled: boolean;
  present: boolean;
  authStatus: string;
  reloginRequired: boolean;
  identityConflict: boolean;
  manuallyDisabled: boolean;
  usageStatus: CodexUsageStatus;
  decisionGrade: boolean;
  planType: string | null;
  limitReached: boolean | null;
  /** Provider-issued rate-limit resets currently available to this account. */
  resetCreditsAvailable?: number | null;
  /** Which measurement produced `lanes`; stale display data is "last-good". */
  measurementSource: "current" | "last-good" | null;
  measuredAtMs: number | null;
  lanes: CodexLane[];
  eligible: boolean;
  exclusions: string[];
  headroomPercent: number | null;
  activeLeases: number;
  nextPollAt: string | null;
  lastError: { code: string; httpStatus: number | null; summary: string | null } | null;
}

export interface CodexObservation {
  schema_version: number;
  observed_at_ms: number;
  health: ObservationHealth;
  dependency: { name: string; version: string | null; healthy: boolean } | null;
  recommendation: { accountKey: string } | null;
  accounts: CodexAccountView[];
  notes: string[];
}

export function isSparkLane(lane: CodexLane): boolean {
  return lane.id === SPARK_LANE_ID;
}

/**
 * A lane's usable headroom is bounded by its tightest window (both the 5-hour
 * and weekly windows must have room), mirroring binding-window semantics.
 */
export function laneHeadroomPercent(lane: CodexLane): number | null {
  if (lane.windows.length === 0) return null;
  let headroom = 100;
  for (const window of lane.windows) {
    const remaining = Math.min(100, Math.max(0, window.remainingPercent));
    if (remaining < headroom) headroom = remaining;
  }
  return headroom;
}

export function sparkLane(account: CodexAccountView): CodexLane | null {
  return account.lanes.find(isSparkLane) ?? null;
}

export function mainLane(account: CodexAccountView): CodexLane | null {
  return account.lanes.find((lane) => lane.id === MAIN_LANE_ID) ?? null;
}

function isLaneWindow(value: unknown): value is CodexLaneWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    (window.role === "primary" || window.role === "secondary" || window.role === "code_review" || window.role === "other") &&
    typeof window.label === "string" &&
    (window.windowSeconds === null || typeof window.windowSeconds === "number") &&
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent) &&
    typeof window.remainingPercent === "number" &&
    Number.isFinite(window.remainingPercent) &&
    (window.resetsAt === null || typeof window.resetsAt === "string") &&
    (window.resetAfterSeconds === null || typeof window.resetAfterSeconds === "number") &&
    (window.limitName === null || typeof window.limitName === "string") &&
    (window.meteredFeature === null || typeof window.meteredFeature === "string")
  );
}

const USAGE_STATUSES: readonly CodexUsageStatus[] = ["ok", "stale", "unknown", "error", "backoff", "quarantined"];

export function validateCodexObservation(value: unknown): CodexObservation | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== CODEX_OBSERVATION_SCHEMA_VERSION) return null;
  if (typeof raw.observed_at_ms !== "number" || !Number.isFinite(raw.observed_at_ms)) return null;
  if (typeof raw.health !== "string") return null;
  if (!Array.isArray(raw.accounts)) return null;
  if (!Array.isArray(raw.notes) || !raw.notes.every((note) => typeof note === "string")) return null;
  for (const candidate of raw.accounts) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const account = candidate as Record<string, unknown>;
    if (typeof account.accountKey !== "string" || account.accountKey.length === 0) return null;
    if (!USAGE_STATUSES.includes(account.usageStatus as CodexUsageStatus)) return null;
    if (!Array.isArray(account.lanes)) return null;
    for (const lane of account.lanes) {
      if (typeof lane !== "object" || lane === null) return null;
      const laneRecord = lane as Record<string, unknown>;
      if (typeof laneRecord.id !== "string" || typeof laneRecord.title !== "string") return null;
      if (typeof laneRecord.binding !== "boolean") return null;
      if (!Array.isArray(laneRecord.windows) || !laneRecord.windows.every(isLaneWindow)) return null;
    }
    if (!Array.isArray(account.exclusions) || !account.exclusions.every((entry) => typeof entry === "string")) {
      return null;
    }
    const resetCreditsAvailable = account.resetCreditsAvailable;
    if (
      resetCreditsAvailable !== undefined &&
      resetCreditsAvailable !== null &&
      (typeof resetCreditsAvailable !== "number" ||
        !Number.isSafeInteger(resetCreditsAvailable) ||
        resetCreditsAvailable < 0)
    ) {
      return null;
    }
  }
  return value as CodexObservation;
}
