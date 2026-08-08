import { CODEX_OBSERVATION_FRESHNESS_CEILING_MS, MAX_OUTPUT_BYTES } from "../constants.ts";
import { codexSwapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";
import {
  type CodexAccountView,
  type CodexObservation,
  laneHeadroomPercent,
  sparkLane,
} from "../codex/types.ts";

/**
 * Codex balance. The main lane delegates to `codex-swap select` — the
 * claude-swap-approach selection codex-swap already implements (leases,
 * cooldowns, decision-grade trust). The spark lane is selected locally from
 * the observation: spark quota is independent of the main lane and keeps
 * working after main exhaustion, so main-lane exclusions must not veto it.
 */

const SELECT_TIMEOUT_MS = 60_000;

export interface CodexLease {
  leaseId: string;
  ownerNonce: string | null;
  accountKey: string;
  expiresAt: string | null;
}

export interface CodexSelectionSuccess {
  ok: true;
  lane: "main" | "codex-spark";
  accountKey: string;
  email: string | null;
  label: string | null;
  reason: string;
  score: number | null;
  lease: CodexLease | null;
  /** Spark only: every considered account with its lane headroom. */
  pool?: Array<{ accountKey: string; headroomPercent: number; activeLeases: number }>;
}

export type CodexRefusal =
  | "no-eligible-account"
  | "dependency-unavailable"
  | "provider-error"
  | "observation-unavailable"
  | "observation-stale"
  | "no-spark-capacity";

export interface CodexSelectionRefusal {
  ok: false;
  lane: "main" | "codex-spark";
  refusal: CodexRefusal;
  detail: string;
  nextReadyAt?: string | null;
  exclusions?: unknown[];
}

export type CodexSelection = CodexSelectionSuccess | CodexSelectionRefusal;

export interface SelectCodexOptions {
  strategy?: "best" | "next-available";
  claim?: boolean;
  allowUnknown?: boolean;
  env?: Record<string, string | undefined>;
  /** Filled from the observation sidecar when available, for email/label. */
  observation?: CodexObservation | null;
}

function describeAccount(
  observation: CodexObservation | null | undefined,
  accountKey: string,
): { email: string | null; label: string | null } {
  const account = observation?.accounts.find((candidate) => candidate.accountKey === accountKey);
  return { email: account?.email ?? null, label: account?.label ?? null };
}

export async function selectCodexAccount(options: SelectCodexOptions = {}): Promise<CodexSelection> {
  const argv = [...codexSwapArgv(options.env ?? process.env), "select", "--json"];
  if (options.strategy !== undefined) argv.push("--strategy", options.strategy);
  if (options.claim === true) argv.push("--claim");
  if (options.allowUnknown === true) argv.push("--allow-unknown");

  const run = await runBounded(argv, { timeoutMs: SELECT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  if (run.error !== null) {
    return {
      ok: false,
      lane: "main",
      refusal: run.enoent ? "dependency-unavailable" : "provider-error",
      detail: run.enoent ? `codex-swap binary not found (${argv[0]})` : `codex-swap select ${run.error}`,
    };
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, lane: "main", refusal: "provider-error", detail: "codex-swap select emitted invalid JSON" };
  }
  const error = envelope.error;
  if (error != null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "unknown";
    const details = (typeof record.details === "object" && record.details !== null ? record.details : {}) as Record<
      string,
      unknown
    >;
    return {
      ok: false,
      lane: "main",
      refusal:
        code === "NO_ELIGIBLE_ACCOUNT"
          ? "no-eligible-account"
          : code === "DEPENDENCY_UNSUPPORTED" || code === "DEPENDENCY_UNAVAILABLE"
            ? "dependency-unavailable"
            : "provider-error",
      detail: typeof record.message === "string" ? record.message : code,
      nextReadyAt: typeof details.nextReadyAt === "string" ? details.nextReadyAt : null,
      exclusions: Array.isArray(details.exclusions) ? details.exclusions : [],
    };
  }
  const data = (typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {}) as Record<
    string,
    unknown
  >;
  const selection = (typeof data.selection === "object" && data.selection !== null ? data.selection : {}) as Record<
    string,
    unknown
  >;
  const accountKey = typeof selection.accountKey === "string" ? selection.accountKey : null;
  if (accountKey === null) {
    return { ok: false, lane: "main", refusal: "provider-error", detail: "codex-swap select returned no accountKey" };
  }
  const reason = (typeof selection.reason === "object" && selection.reason !== null ? selection.reason : {}) as Record<
    string,
    unknown
  >;
  const leaseRaw = data.lease;
  const lease =
    typeof leaseRaw === "object" && leaseRaw !== null
      ? {
          leaseId: String((leaseRaw as Record<string, unknown>).leaseId ?? ""),
          ownerNonce:
            typeof (leaseRaw as Record<string, unknown>).ownerNonce === "string"
              ? ((leaseRaw as Record<string, unknown>).ownerNonce as string)
              : null,
          accountKey: String((leaseRaw as Record<string, unknown>).accountKey ?? accountKey),
          expiresAt:
            typeof (leaseRaw as Record<string, unknown>).expiresAt === "string"
              ? ((leaseRaw as Record<string, unknown>).expiresAt as string)
              : null,
        }
      : null;
  return {
    ok: true,
    lane: "main",
    accountKey,
    ...describeAccount(options.observation, accountKey),
    reason: typeof reason.summary === "string" ? reason.summary : "selected",
    score: typeof reason.score === "number" && Number.isFinite(reason.score) ? reason.score : null,
    lease,
  };
}

// ---------------------------------------------------------------------------
// Spark lane — local selection over the observation sidecar.

function sparkAuthEligible(account: CodexAccountView): boolean {
  return (
    account.present &&
    account.enabled &&
    !account.manuallyDisabled &&
    !account.reloginRequired &&
    !account.identityConflict
  );
}

export function selectCodexSpark(observation: CodexObservation, nowMs: number = Date.now()): CodexSelection {
  if (observation.health !== "ok") {
    return {
      ok: false,
      lane: "codex-spark",
      refusal: "observation-unavailable",
      detail: `codex observation health is ${observation.health}`,
    };
  }
  const ageMs = nowMs - observation.observed_at_ms;
  if (ageMs > CODEX_OBSERVATION_FRESHNESS_CEILING_MS) {
    return {
      ok: false,
      lane: "codex-spark",
      refusal: "observation-stale",
      detail: `codex observation is ${Math.round(ageMs / 1000)}s old`,
    };
  }

  const pool: Array<{ account: CodexAccountView; headroomPercent: number }> = [];
  for (const account of observation.accounts) {
    if (!sparkAuthEligible(account)) continue;
    const lane = sparkLane(account);
    if (lane === null) continue;
    const headroom = laneHeadroomPercent(lane);
    if (headroom === null || headroom <= 0) continue;
    pool.push({ account, headroomPercent: headroom });
  }
  if (pool.length === 0) {
    return {
      ok: false,
      lane: "codex-spark",
      refusal: "no-spark-capacity",
      detail:
        observation.accounts.length === 0
          ? "no codex accounts observed"
          : "no auth-eligible account has spark headroom",
    };
  }
  pool.sort((a, b) => {
    if (a.headroomPercent !== b.headroomPercent) return b.headroomPercent - a.headroomPercent;
    if (a.account.activeLeases !== b.account.activeLeases) return a.account.activeLeases - b.account.activeLeases;
    return a.account.accountKey < b.account.accountKey ? -1 : 1;
  });
  const chosen = pool[0]!;
  return {
    ok: true,
    lane: "codex-spark",
    accountKey: chosen.account.accountKey,
    email: chosen.account.email,
    label: chosen.account.label,
    reason: "spark-headroom",
    score: chosen.headroomPercent,
    lease: null,
    pool: pool.map((entry) => ({
      accountKey: entry.account.accountKey,
      headroomPercent: entry.headroomPercent,
      activeLeases: entry.account.activeLeases,
    })),
  };
}
