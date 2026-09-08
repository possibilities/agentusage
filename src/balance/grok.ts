import { GROK_OBSERVATION_FRESHNESS_CEILING_MS, RESERVATION_TTL_MS } from "../constants.ts";
import type { FocusStatus, FullFocusEffectiveState, FullFocusPolicy } from "../focus.ts";
import { grokAccountEligible, type GrokObservation } from "../grok/types.ts";
import { statePaths } from "../paths.ts";
import { AccountError } from "../accounts/storage.ts";
import { GrokError } from "../grok/model.ts";
import { selectAccount } from "../grok/select.ts";
import { readState, withState } from "../grok/store.ts";

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

async function selectOwnedGrok(options: SelectGrokOptions, account?: string): Promise<GrokSelection> {
  const paths = statePaths(options.env ?? process.env);
  const request = {
    mode: options.strategy ?? "best",
    account: account ?? null,
    allowUnknown: options.allowUnknown === true,
    dryRun: options.claim !== true,
    reserveSeconds: options.reserveSeconds ?? Math.round(RESERVATION_TTL_MS / 1000),
    now: options.nowMs,
  };
  try {
    const result = request.dryRun
      ? selectAccount(await readState(paths), request)
      : await withState(paths, (state) => ({ result: selectAccount(state, request), changed: true }));
    return {
      ok: true, accountKey: result.account.accountKey, displayName: result.account.displayName,
      alias: result.account.alias, email: result.account.email, reason: result.reason,
      score: result.score, dryRun: result.dryRun, reservation: result.reservation,
    };
  } catch (error) {
    const known = error instanceof AccountError;
    const code = known ? error.code : "selection_failed";
    return {
      ok: false, refusal: mapRefusal(code),
      detail: known ? error.message : "Grok account selection failed",
      providerCode: code,
      ...(error instanceof GrokError && error.details !== undefined ? { details: error.details } : {}),
    };
  }
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
  if (options.account !== undefined) return selectOwnedGrok(options, options.account);

  const focus = options.focus ?? null;
  const focusTarget = focus?.state === "active" && focus.policy !== null ? focus.policy.target : null;
  if (focusTarget === null) return selectOwnedGrok(options);

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
    const pinned = await selectOwnedGrok(options, account.accountKey);
    if (pinned.ok) return { ...pinned, reason: "full-focus" };
    if (!focusCanFallback(pinned)) return pinned;
  }
  const fallback = await selectOwnedGrok(options);
  return fallback.ok ? { ...fallback, reason: `full-focus-fallback (${fallback.reason})` } : fallback;
}
