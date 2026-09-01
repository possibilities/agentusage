import { CODEX_OBSERVATION_FRESHNESS_CEILING_MS, MAX_OUTPUT_BYTES } from "../constants.ts";
import { codexSwapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";
import {
  type CodexAccountView,
  type CodexObservation,
  laneHeadroomPercent,
  mainLane,
  sparkLane,
} from "../codex/types.ts";
import type { FocusStatus, FullFocusEffectiveState, FullFocusPolicy } from "../focus.ts";

/**
 * Codex balance. The main lane delegates to `codex-swap select` — the
 * claude-swap-approach selection codex-swap already implements (leases,
 * cooldowns, decision-grade trust). The spark lane is selected locally from
 * the observation: spark quota is independent of the main lane and keeps
 * working after main exhaustion, so main-lane exclusions must not veto it.
 *
 * An active codex focus uses the observation to gate its target, then
 * delegates a pinned selection to codex-swap so real launches retain atomic
 * lease accounting. An ineligible focus target falls back to plain selection.
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
  /** Effective codex focus; an eligible active target pins provider selection. */
  focus?: FocusStatus<FullFocusPolicy, FullFocusEffectiveState> | null;
  nowMs?: number;
}

function describeAccount(
  observation: CodexObservation | null | undefined,
  accountKey: string,
): { email: string | null; label: string | null } {
  const account = observation?.accounts.find((candidate) => candidate.accountKey === accountKey);
  return { email: account?.email ?? null, label: account?.label ?? null };
}

export async function selectCodexAccount(options: SelectCodexOptions = {}): Promise<CodexSelection> {
  const focus = options.focus ?? null;
  const focusTarget = focus !== null && focus.state === "active" && focus.policy !== null ? focus.policy.target : null;
  if (focusTarget !== null) {
    const observation = options.observation ?? null;
    if (observation === null || observation.health !== "ok") {
      return {
        ok: false,
        lane: "main",
        refusal: "observation-unavailable",
        detail: "codex focus needs a healthy observation to gate its target",
      };
    }
    const nowMs = options.nowMs ?? Date.now();
    const ageMs = nowMs - observation.observed_at_ms;
    if (ageMs > CODEX_OBSERVATION_FRESHNESS_CEILING_MS) {
      return {
        ok: false,
        lane: "main",
        refusal: "observation-stale",
        detail: `codex observation is ${Math.round(ageMs / 1000)}s old`,
      };
    }
    const account = observation.accounts.find((candidate) => candidate.accountKey === focusTarget);
    const lane = account === undefined ? null : mainLane(account);
    const headroom = lane === null ? null : laneHeadroomPercent(lane);
    if (account !== undefined && codexAuthEligible(account) && headroom !== null && headroom > 0) {
      const pinned = await delegateCodexSelect(options, focusTarget);
      if (pinned.ok) return { ...pinned, reason: "full-focus" };
      if (pinned.refusal === "no-eligible-account") {
        const delegated = await delegateCodexSelect(options);
        if (delegated.ok) return { ...delegated, reason: `full-focus-fallback (${delegated.reason})` };
        return delegated;
      }
      return pinned;
    }
    const delegated = await delegateCodexSelect(options);
    if (delegated.ok) return { ...delegated, reason: `full-focus-fallback (${delegated.reason})` };
    return delegated;
  }
  return delegateCodexSelect(options);
}

type SelectEnvelopeOutcome =
  | { ok: true; accountKey: string; reasonSummary: string; score: number | null; lease: CodexLease | null }
  | { ok: false; refusal: CodexRefusal; detail: string; nextReadyAt?: string | null; exclusions?: unknown[] };

/** Shared codex-swap `select` envelope parsing for both main-lane delegation and Spark claims. */
function parseSelectRun(run: Awaited<ReturnType<typeof runBounded>>, argv: readonly string[]): SelectEnvelopeOutcome {
  if (run.error !== null) {
    return {
      ok: false,
      refusal: run.enoent ? "dependency-unavailable" : "provider-error",
      detail: run.enoent ? `codex-swap binary not found (${argv[0]})` : `codex-swap select ${run.error}`,
    };
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, refusal: "provider-error", detail: "codex-swap select emitted invalid JSON" };
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
    return { ok: false, refusal: "provider-error", detail: "codex-swap select returned no accountKey" };
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
    accountKey,
    reasonSummary: typeof reason.summary === "string" ? reason.summary : "selected",
    score: typeof reason.score === "number" && Number.isFinite(reason.score) ? reason.score : null,
    lease,
  };
}

async function delegateCodexSelect(options: SelectCodexOptions, requiredAccountKey?: string): Promise<CodexSelection> {
  const argv = [...codexSwapArgv(options.env ?? process.env), "select", "--json"];
  if (options.strategy !== undefined) argv.push("--strategy", options.strategy);
  if (requiredAccountKey !== undefined) argv.push("--account", requiredAccountKey);
  if (options.claim === true) argv.push("--claim");
  if (options.allowUnknown === true) argv.push("--allow-unknown");

  const run = await runBounded(argv, { timeoutMs: SELECT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  const outcome = parseSelectRun(run, argv);
  if (!outcome.ok) {
    return { lane: "main", ...outcome };
  }
  return {
    ok: true,
    lane: "main",
    accountKey: outcome.accountKey,
    ...describeAccount(options.observation, outcome.accountKey),
    reason: outcome.reasonSummary,
    score: outcome.score,
    lease: outcome.lease,
  };
}

// ---------------------------------------------------------------------------
// Spark lane — local selection over the observation sidecar.

export function codexAuthEligible(account: CodexAccountView): boolean {
  return (
    account.present &&
    account.enabled &&
    !account.manuallyDisabled &&
    !account.reloginRequired &&
    !account.identityConflict
  );
}

export function selectCodexSpark(
  observation: CodexObservation,
  nowMs: number = Date.now(),
  focusTarget: string | null = null,
): CodexSelection {
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
    if (!codexAuthEligible(account)) continue;
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
  const pinned = focusTarget === null ? undefined : pool.find((entry) => entry.account.accountKey === focusTarget);
  const chosen = pinned ?? pool[0]!;
  return {
    ok: true,
    lane: "codex-spark",
    accountKey: chosen.account.accountKey,
    email: chosen.account.email,
    label: chosen.account.label,
    reason: pinned !== undefined ? "full-focus" : focusTarget !== null ? "full-focus-fallback (spark-headroom)" : "spark-headroom",
    score: chosen.headroomPercent,
    lease: null,
    pool: pool.map((entry) => ({
      accountKey: entry.account.accountKey,
      headroomPercent: entry.headroomPercent,
      activeLeases: entry.account.activeLeases,
    })),
  };
}

const SPARK_CLAIM_LANE = "codex-spark";
const MAX_SPARK_CLAIM_ATTEMPTS = 2;

export interface ClaimCodexSparkOptions {
  observation: CodexObservation;
  model: string;
  focusTarget: string | null;
  env?: Record<string, string | undefined>;
}

function sparkClaimReason(focusTarget: string | null, accountKey: string): string {
  if (focusTarget === null) return "spark-headroom";
  return accountKey === focusTarget ? "full-focus" : "full-focus-fallback (spark-headroom)";
}

/**
 * A claim's success envelope is only usable when it actually proves a lease
 * on the exact account requested: codex-swap's `select --claim` contract is
 * frozen, so a lease-shaped hole here (null lease, blank lease id, or a
 * selection/lease `accountKey` that drifted from what was requested) must
 * fail closed rather than be trusted as a claim on the wrong — or no —
 * account. This is claim-specific: `parseSelectRun` is shared with plain
 * `select` delegation, where no lease is a legitimate response.
 */
function validateSparkClaimOutcome(requestedAccountKey: string, outcome: SelectEnvelopeOutcome): SelectEnvelopeOutcome {
  if (!outcome.ok) return outcome;
  if (outcome.lease === null) {
    return { ok: false, refusal: "provider-error", detail: "codex-swap select --claim returned no lease" };
  }
  if (outcome.accountKey !== requestedAccountKey) {
    return {
      ok: false,
      refusal: "provider-error",
      detail: `codex-swap select --claim returned selection accountKey "${outcome.accountKey}" for requested "${requestedAccountKey}"`,
    };
  }
  if (outcome.lease.accountKey !== requestedAccountKey) {
    return {
      ok: false,
      refusal: "provider-error",
      detail: `codex-swap select --claim returned lease accountKey "${outcome.lease.accountKey}" for requested "${requestedAccountKey}"`,
    };
  }
  if (outcome.lease.leaseId.length === 0) {
    return { ok: false, refusal: "provider-error", detail: "codex-swap select --claim returned an empty leaseId" };
  }
  return outcome;
}

async function runCodexSparkClaim(
  accountKey: string,
  model: string,
  env: Record<string, string | undefined> | undefined,
): Promise<SelectEnvelopeOutcome> {
  const argv = [
    ...codexSwapArgv(env ?? process.env),
    "select",
    "--account",
    accountKey,
    "--claim",
    "--metered-lane",
    SPARK_CLAIM_LANE,
    "--model",
    model,
    "--json",
  ];
  const run = await runBounded(argv, { timeoutMs: SELECT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  return validateSparkClaimOutcome(accountKey, parseSelectRun(run, argv));
}

/**
 * Claim the account `selectCodexSpark` chose through the frozen codex-swap
 * `--metered-lane codex-spark` primitive. Only a structured
 * `NO_ELIGIBLE_ACCOUNT` refusal retries, and only once, against the next
 * differently keyed account from the already-ranked pool: every other
 * failure (dependency, malformed envelope, auth, identity, ...) fails
 * closed immediately, and at most two claim attempts are ever made.
 */
export async function claimCodexSpark(
  selection: CodexSelectionSuccess,
  options: ClaimCodexSparkOptions,
): Promise<CodexSelection> {
  const ranked =
    selection.pool !== undefined && selection.pool.length > 0
      ? selection.pool
      : [{ accountKey: selection.accountKey, headroomPercent: selection.score ?? 0, activeLeases: 0 }];

  const attempted = new Set<string>();
  let candidate = ranked.find((entry) => entry.accountKey === selection.accountKey) ?? ranked[0]!;
  let lastDetail = "no spark account was available to claim";

  for (let attempt = 0; attempt < MAX_SPARK_CLAIM_ATTEMPTS; attempt += 1) {
    attempted.add(candidate.accountKey);
    const outcome = await runCodexSparkClaim(candidate.accountKey, options.model, options.env);
    if (outcome.ok) {
      return {
        ok: true,
        lane: "codex-spark",
        accountKey: outcome.accountKey,
        ...describeAccount(options.observation, outcome.accountKey),
        reason: sparkClaimReason(options.focusTarget, outcome.accountKey),
        score: candidate.headroomPercent,
        lease: outcome.lease,
        pool: selection.pool,
      };
    }
    if (outcome.refusal !== "no-eligible-account") {
      return { lane: "codex-spark", ...outcome };
    }
    lastDetail = outcome.detail;
    const next = ranked.find((entry) => !attempted.has(entry.accountKey));
    if (next === undefined) break;
    candidate = next;
  }
  return { ok: false, lane: "codex-spark", refusal: "no-spark-capacity", detail: lastDetail };
}
