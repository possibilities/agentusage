import { GROK_OBSERVATION_FRESHNESS_CEILING_MS, MAX_OUTPUT_BYTES, RESERVATION_TTL_MS } from "../constants.ts";
import type { FocusStatus, FullFocusEffectiveState, FullFocusPolicy } from "../focus.ts";
import { grokAccountEligible, type GrokObservation } from "../grok/types.ts";
import { grokSwapArgv } from "../paths.ts";
import { runBounded } from "../proc.ts";

const SELECT_TIMEOUT_MS = 60_000;

export type GrokSelectionTier = "included" | "prepaid" | "payg" | "unknown";

export interface GrokReservation {
  id: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface GrokSelectionSuccess {
  ok: true;
  accountKey: string;
  displayName: string;
  alias: string | null;
  email: string | null;
  reason: string;
  score: {
    tier: GrokSelectionTier;
    remainingIncludedPercent: number | null;
    remainingDollars: number | null;
  };
  dryRun: boolean;
  reservation: GrokReservation | null;
}

export type GrokRefusal =
  | "no-eligible-account"
  | "account-not-found"
  | "account-disabled"
  | "account-reserved"
  | "usage-unknown"
  | "auth-unavailable"
  | "dependency-unavailable"
  | "provider-error"
  | "observation-unavailable"
  | "observation-stale";

export interface GrokSelectionRefusal {
  ok: false;
  refusal: GrokRefusal;
  detail: string;
  providerCode?: string;
  details?: unknown;
}

export type GrokSelection = GrokSelectionSuccess | GrokSelectionRefusal;

export interface SelectGrokOptions {
  strategy?: "best" | "next-available";
  account?: string;
  claim?: boolean;
  reserveSeconds?: number;
  allowUnknown?: boolean;
  env?: Record<string, string | undefined>;
  observation?: GrokObservation | null;
  focus?: FocusStatus<FullFocusPolicy, FullFocusEffectiveState> | null;
  nowMs?: number;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapRefusal(code: string): GrokRefusal {
  switch (code) {
    case "no_eligible_account":
    case "account_exhausted":
      return "no-eligible-account";
    case "account_not_found":
      return "account-not-found";
    case "account_disabled":
      return "account-disabled";
    case "account_reserved":
      return "account-reserved";
    case "usage_unknown":
      return "usage-unknown";
    case "auth_unavailable":
      return "auth-unavailable";
    default:
      return "provider-error";
  }
}

function parseSelectionRun(run: Awaited<ReturnType<typeof runBounded>>, argv: readonly string[]): GrokSelection {
  if (run.error !== null) {
    return {
      ok: false,
      refusal: run.enoent ? "dependency-unavailable" : "provider-error",
      detail: run.enoent ? `grok-swap binary not found (${argv[0]})` : `grok-swap select ${run.error}`,
    };
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, refusal: "provider-error", detail: "grok-swap select emitted invalid JSON" };
  }
  if (envelope.schema_version !== 1 || envelope.provider !== "grok") {
    return { ok: false, refusal: "provider-error", detail: "grok-swap select returned an unsupported envelope" };
  }
  if (envelope.ok !== true) {
    const error = (typeof envelope.error === "object" && envelope.error !== null ? envelope.error : {}) as Record<
      string,
      unknown
    >;
    const code = stringOrNull(error.code) ?? "unknown";
    return {
      ok: false,
      refusal: mapRefusal(code),
      detail: stringOrNull(error.message) ?? code,
      providerCode: code,
      details: error.details,
    };
  }
  const data = (typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {}) as Record<
    string,
    unknown
  >;
  const account = (typeof data.account === "object" && data.account !== null ? data.account : {}) as Record<
    string,
    unknown
  >;
  const accountKey = stringOrNull(account.accountKey);
  const displayName = stringOrNull(account.displayName);
  if (accountKey === null || displayName === null) {
    return { ok: false, refusal: "provider-error", detail: "grok-swap select returned no account identity" };
  }
  const score = (typeof data.score === "object" && data.score !== null ? data.score : {}) as Record<string, unknown>;
  const tier = score.tier;
  if (tier !== "included" && tier !== "prepaid" && tier !== "payg" && tier !== "unknown") {
    return { ok: false, refusal: "provider-error", detail: "grok-swap select returned an invalid score tier" };
  }
  const reservationRaw = data.reservation;
  let reservation: GrokReservation | null = null;
  if (typeof reservationRaw === "object" && reservationRaw !== null) {
    const row = reservationRaw as Record<string, unknown>;
    const id = stringOrNull(row.id);
    if (id === null) {
      return { ok: false, refusal: "provider-error", detail: "grok-swap select returned an invalid reservation" };
    }
    reservation = { id, createdAt: stringOrNull(row.createdAt), expiresAt: stringOrNull(row.expiresAt) };
  }
  const dryRun = data.dryRun === true;
  if (!dryRun && reservation === null) {
    return { ok: false, refusal: "provider-error", detail: "grok-swap reserved selection returned no reservation" };
  }
  return {
    ok: true,
    accountKey,
    displayName,
    alias: stringOrNull(account.alias),
    email: stringOrNull(account.email),
    reason: stringOrNull(data.reason) ?? "selected",
    score: {
      tier,
      remainingIncludedPercent: finiteOrNull(score.remainingIncludedPercent),
      remainingDollars: finiteOrNull(score.remainingDollars),
    },
    dryRun,
    reservation,
  };
}

async function delegateGrokSelect(options: SelectGrokOptions, account?: string): Promise<GrokSelection> {
  const argv = [...grokSwapArgv(options.env ?? process.env), "select", "--json"];
  if (account !== undefined) argv.push("--account", account);
  else if (options.strategy !== undefined) argv.push("--mode", options.strategy);
  if (options.allowUnknown === true) argv.push("--allow-unknown");
  if (options.claim === true) {
    const seconds = options.reserveSeconds ?? Math.round(RESERVATION_TTL_MS / 1000);
    argv.push("--reserve-seconds", String(seconds));
  } else {
    argv.push("--dry-run");
  }
  const run = await runBounded(argv, { timeoutMs: SELECT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  return parseSelectionRun(run, argv);
}

function focusCanFallback(selection: GrokSelectionRefusal): boolean {
  return (
    selection.refusal === "no-eligible-account" ||
    selection.refusal === "account-not-found" ||
    selection.refusal === "account-disabled" ||
    selection.refusal === "account-reserved" ||
    selection.refusal === "usage-unknown" ||
    selection.refusal === "auth-unavailable"
  );
}

export async function selectGrokAccount(options: SelectGrokOptions = {}): Promise<GrokSelection> {
  // An explicit caller account always wins over durable focus.
  if (options.account !== undefined) return delegateGrokSelect(options, options.account);

  const focus = options.focus ?? null;
  const focusTarget = focus?.state === "active" && focus.policy !== null ? focus.policy.target : null;
  if (focusTarget === null) return delegateGrokSelect(options);

  const observation = options.observation ?? null;
  if (observation === null || observation.health !== "ok") {
    return {
      ok: false,
      refusal: "observation-unavailable",
      detail: "grok focus needs a healthy observation to gate its target",
    };
  }
  const nowMs = options.nowMs ?? Date.now();
  const ageMs = nowMs - observation.observed_at_ms;
  if (ageMs > GROK_OBSERVATION_FRESHNESS_CEILING_MS) {
    return {
      ok: false,
      refusal: "observation-stale",
      detail: `grok observation is ${Math.round(ageMs / 1000)}s old`,
    };
  }
  const account = observation.accounts.find(
    (candidate) => candidate.accountKey === focusTarget || candidate.displayName === focusTarget,
  );
  if (account !== undefined && grokAccountEligible(account, options.allowUnknown)) {
    const pinned = await delegateGrokSelect(options, account.accountKey);
    if (pinned.ok) return { ...pinned, reason: "full-focus" };
    if (!focusCanFallback(pinned)) return pinned;
  }
  const fallback = await delegateGrokSelect(options);
  return fallback.ok ? { ...fallback, reason: `full-focus-fallback (${fallback.reason})` } : fallback;
}
