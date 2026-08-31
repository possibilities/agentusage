import { MAX_OUTPUT_BYTES } from "../constants.ts";
import { codexSwapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";
import {
  CODEX_OBSERVATION_SCHEMA_VERSION,
  type CodexAccountView,
  type CodexLane,
  type CodexLaneWindow,
  type CodexObservation,
  type CodexUsageStatus,
  type CodexWindowRole,
  MAIN_LANE_ID,
  SPARK_LANE_ID,
} from "./types.ts";

/** snapshot's fetch pass touches the network (bounded to ~2 accounts). */
const SNAPSHOT_TIMEOUT_MS = 60_000;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

interface WireWindow {
  kind: CodexWindowRole;
  label: string;
  windowSeconds: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetAfterSeconds: number | null;
  limitName: string | null;
  meteredFeature: string | null;
}

function parseWireWindow(value: unknown): WireWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const window = value as Record<string, unknown>;
  const kind = window.kind;
  if (kind !== "primary" && kind !== "secondary" && kind !== "code_review" && kind !== "other") return null;
  const usedPercent = finiteOrNull(window.usedPercent);
  const remainingPercent = finiteOrNull(window.remainingPercent);
  if (usedPercent === null || remainingPercent === null) return null;
  return {
    kind,
    label: stringOrNull(window.label) ?? "window",
    windowSeconds: finiteOrNull(window.windowSeconds),
    usedPercent,
    remainingPercent,
    resetsAt: stringOrNull(window.resetsAt),
    resetAfterSeconds: finiteOrNull(window.resetAfterSeconds),
    limitName: stringOrNull(window.limitName),
    meteredFeature: stringOrNull(window.meteredFeature),
  };
}

function toLaneWindow(window: WireWindow): CodexLaneWindow {
  return {
    role: window.kind,
    label: window.label,
    windowSeconds: window.windowSeconds,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
    resetAfterSeconds: window.resetAfterSeconds,
    limitName: window.limitName,
    meteredFeature: window.meteredFeature,
  };
}

/**
 * Groups measurement windows into lanes. Identity comes from the lane fields
 * codex-swap passes through verbatim; spark detection is the CodexBar
 * convention (lowercased substring "spark") so label drift keeps matching.
 */
export function groupLanes(windows: readonly unknown[]): CodexLane[] {
  const main: CodexLaneWindow[] = [];
  const codeReview: CodexLaneWindow[] = [];
  const labeled = new Map<string, { title: string; windows: CodexLaneWindow[] }>();
  const unlabeled: CodexLaneWindow[] = [];

  for (const candidate of windows) {
    const wire = parseWireWindow(candidate);
    if (wire === null) continue;
    const window = toLaneWindow(wire);
    if (wire.kind === "primary" || wire.kind === "secondary") {
      main.push(window);
      continue;
    }
    if (wire.kind === "code_review") {
      codeReview.push(window);
      continue;
    }
    const identity = wire.meteredFeature ?? wire.limitName;
    if (identity === null) {
      unlabeled.push(window);
      continue;
    }
    const laneId = identity.toLowerCase().includes("spark") ? SPARK_LANE_ID : `codex-${slug(identity)}`;
    const title = wire.limitName ?? wire.meteredFeature ?? "Additional";
    const lane = labeled.get(laneId) ?? { title, windows: [] };
    lane.windows.push(window);
    labeled.set(laneId, lane);
  }

  const lanes: CodexLane[] = [];
  if (main.length > 0) lanes.push({ id: MAIN_LANE_ID, title: "Main", binding: true, windows: main });
  for (const [id, lane] of labeled) {
    lanes.push({ id, title: lane.title, binding: false, windows: lane.windows });
  }
  if (codeReview.length > 0) lanes.push({ id: "code-review", title: "Code Review", binding: false, windows: codeReview });
  if (unlabeled.length > 0) lanes.push({ id: "codex-extra", title: "Additional", binding: false, windows: unlabeled });
  return lanes;
}

const USAGE_STATUSES: readonly CodexUsageStatus[] = ["ok", "stale", "unknown", "error", "backoff", "quarantined"];

function parseAccount(value: unknown, notes: string[]): CodexAccountView | null {
  if (typeof value !== "object" || value === null) {
    notes.push("dropped a non-object codex account row");
    return null;
  }
  const row = value as Record<string, unknown>;
  const accountKey = stringOrNull(row.accountKey);
  if (accountKey === null) {
    notes.push("dropped a codex account row without accountKey");
    return null;
  }
  const auth = (typeof row.auth === "object" && row.auth !== null ? row.auth : {}) as Record<string, unknown>;
  const policy = (typeof row.policy === "object" && row.policy !== null ? row.policy : {}) as Record<string, unknown>;
  const usage = (typeof row.usage === "object" && row.usage !== null ? row.usage : {}) as Record<string, unknown>;
  const selection = (typeof row.selection === "object" && row.selection !== null ? row.selection : {}) as Record<
    string,
    unknown
  >;

  const usageStatus = USAGE_STATUSES.includes(usage.status as CodexUsageStatus)
    ? (usage.status as CodexUsageStatus)
    : "unknown";

  let measurement = usage.measurement;
  let measurementSource: "current" | "last-good" | null = measurement != null ? "current" : null;
  let measuredAtIso = measurementSource === "current" ? stringOrNull(usage.fetchedAt) : null;
  if (measurement == null) {
    const lastGood = row.lastGoodUsage;
    if (typeof lastGood === "object" && lastGood !== null) {
      measurement = (lastGood as Record<string, unknown>).measurement;
      if (measurement != null) {
        measurementSource = "last-good";
        measuredAtIso = stringOrNull((lastGood as Record<string, unknown>).fetchedAt);
      }
    }
  }
  const measurementRecord = (
    typeof measurement === "object" && measurement !== null ? measurement : {}
  ) as Record<string, unknown>;
  const windows = Array.isArray(measurementRecord.windows) ? measurementRecord.windows : [];
  const measuredAtMs = measuredAtIso !== null && Number.isFinite(Date.parse(measuredAtIso)) ? Date.parse(measuredAtIso) : null;

  const lastErrorRaw = usage.lastError;
  const lastError =
    typeof lastErrorRaw === "object" && lastErrorRaw !== null
      ? {
          code: stringOrNull((lastErrorRaw as Record<string, unknown>).code) ?? "unknown",
          httpStatus: finiteOrNull((lastErrorRaw as Record<string, unknown>).httpStatus),
          summary: stringOrNull((lastErrorRaw as Record<string, unknown>).summary),
        }
      : null;

  return {
    accountKey,
    email: stringOrNull(row.email),
    label: stringOrNull(row.label),
    ndyIndex: finiteOrNull(row.ndyIndex),
    enabled: row.enabled === true,
    present: row.present === true,
    authStatus: stringOrNull(auth.status) ?? "unknown",
    reloginRequired: auth.reloginRequired === true,
    identityConflict: row.identityConflict === true,
    manuallyDisabled: policy.manuallyDisabled === true,
    usageStatus,
    decisionGrade: usage.decisionGrade === true,
    planType: stringOrNull(measurementRecord.planType),
    limitReached: typeof measurementRecord.limitReached === "boolean" ? measurementRecord.limitReached : null,
    resetCreditsAvailable: nonNegativeIntegerOrNull(measurementRecord.resetCreditsAvailable),
    measurementSource: measurementSource !== null && windows.length >= 0 ? measurementSource : null,
    measuredAtMs,
    lanes: measurementSource === null ? [] : groupLanes(windows),
    eligible: selection.eligible === true,
    exclusions: Array.isArray(selection.exclusions)
      ? selection.exclusions.filter((entry): entry is string => typeof entry === "string")
      : [],
    headroomPercent: finiteOrNull(selection.headroomPercent),
    activeLeases: finiteOrNull(selection.activeLeases) ?? 0,
    nextPollAt: stringOrNull(usage.nextPollAt),
    lastError,
  };
}

function emptyCodexObservation(nowMs: number, health: CodexObservation["health"], notes: string[]): CodexObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health,
    dependency: null,
    recommendation: null,
    accounts: [],
    notes,
  };
}

/** Builds the codex observation from a parsed `codex-swap snapshot --json` envelope. */
export function buildCodexObservation(envelope: unknown, nowMs: number): CodexObservation {
  if (typeof envelope !== "object" || envelope === null) {
    return emptyCodexObservation(nowMs, "malformed", ["codex-swap envelope is not an object"]);
  }
  const root = envelope as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    return emptyCodexObservation(nowMs, "unsupported", [`codex-swap envelope schemaVersion ${String(root.schemaVersion)}`]);
  }
  if (root.error != null) {
    const error = root.error as Record<string, unknown>;
    const code = stringOrNull(error.code) ?? "unknown";
    const summary = stringOrNull(error.summary) ?? stringOrNull(error.message) ?? "";
    return emptyCodexObservation(nowMs, "error", [`codex-swap snapshot error ${code}${summary ? `: ${summary}` : ""}`]);
  }
  const data = root.data;
  if (typeof data !== "object" || data === null) {
    return emptyCodexObservation(nowMs, "malformed", ["codex-swap envelope has no data"]);
  }
  const snapshot = data as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1) {
    return emptyCodexObservation(nowMs, "unsupported", [`codex-swap snapshot schemaVersion ${String(snapshot.schemaVersion)}`]);
  }

  const notes: string[] = [];
  const accounts: CodexAccountView[] = [];
  if (Array.isArray(snapshot.accounts)) {
    for (const row of snapshot.accounts) {
      const account = parseAccount(row, notes);
      if (account !== null) accounts.push(account);
    }
  } else {
    notes.push("codex-swap snapshot has no accounts array");
  }

  const dependencyRaw = snapshot.dependency;
  const dependency =
    typeof dependencyRaw === "object" && dependencyRaw !== null
      ? {
          name: stringOrNull((dependencyRaw as Record<string, unknown>).name) ?? "codex-multi-auth",
          version: stringOrNull((dependencyRaw as Record<string, unknown>).version),
          healthy: (dependencyRaw as Record<string, unknown>).healthy === true,
        }
      : null;

  const recommendationRaw = snapshot.recommendation;
  const recommendationKey =
    typeof recommendationRaw === "object" && recommendationRaw !== null
      ? stringOrNull((recommendationRaw as Record<string, unknown>).accountKey)
      : null;

  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    health: "ok",
    dependency,
    recommendation: recommendationKey === null ? null : { accountKey: recommendationKey },
    accounts,
    notes,
  };
}

export interface ObserveCodexOptions {
  env?: Record<string, string | undefined>;
  /** Serve stored state only — no network fetch (TUI/status refreshes). */
  noFetch?: boolean;
}

export async function observeCodex(options: ObserveCodexOptions = {}): Promise<CodexObservation> {
  const nowMs = Date.now();
  const env = options.env ?? process.env;
  const argv = [...codexSwapArgv(env), "snapshot", "--json"];
  if (options.noFetch === true) argv.push("--no-fetch");
  const run = await runBounded(argv, { timeoutMs: SNAPSHOT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  if (run.error === "spawn-failed") {
    return emptyCodexObservation(nowMs, run.enoent ? "absent" : "error", [
      run.enoent ? `codex-swap binary not found (${argv[0]})` : "codex-swap spawn failed",
    ]);
  }
  if (run.error === "timeout") return emptyCodexObservation(nowMs, "error", ["codex-swap snapshot timed out"]);
  if (run.error === "output-cap") return emptyCodexObservation(nowMs, "error", ["codex-swap snapshot output exceeded cap"]);
  let payload: unknown = null;
  if (run.stdout.trim().length > 0) {
    try {
      payload = JSON.parse(run.stdout);
    } catch {
      return emptyCodexObservation(nowMs, "malformed", ["codex-swap snapshot emitted invalid JSON"]);
    }
  }
  if (run.code !== 0 && payload === null) {
    const detail = run.stderr.trim().split("\n").at(-1) ?? "";
    return emptyCodexObservation(nowMs, "error", [
      `codex-swap snapshot exited ${run.code}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ]);
  }
  return buildCodexObservation(payload, nowMs);
}
