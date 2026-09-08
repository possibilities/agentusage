import { AccountError } from "../accounts/storage.ts";
import { statePaths } from "../paths.ts";
import { observeAccount, publicObservation } from "./billing.ts";
import type { StoredAccount } from "./model.ts";
import { GrokError } from "./model.ts";
import { readState, resolveAccount, withState } from "./store.ts";
import { GROK_OBSERVATION_SCHEMA_VERSION, type GrokObservation } from "./types.ts";

const REFRESH_BUDGET_MS = 55_000;

export function buildGrokObservation(
  stored: readonly StoredAccount[],
  nowMs: number,
  notes: string[] = [],
): GrokObservation {
  const accounts = [...stored].sort((a, b) => a.ordinal - b.ordinal).map((account) => {
    const row = publicObservation(account, nowMs);
    return {
      accountKey: row.accountKey, displayName: row.displayName, ordinal: row.ordinal,
      alias: row.alias, email: row.email, enabled: row.enabled, authStatus: row.authStatus,
      expiresAt: row.expiresAt, billingStatus: row.billingStatus,
      included: {
        ...row.included,
        periodType: row.included.periodType?.toLowerCase().replace(/^usage_period_type_/u, "") ?? null,
      },
      prepaid: row.prepaid, payg: row.payg, subscriptionTier: row.subscriptionTier,
      observedAtMs: row.observedAt === null ? null : Date.parse(row.observedAt),
      lastGoodAtMs: row.lastGoodAt === null ? null : Date.parse(row.lastGoodAt),
      stale: row.stale, error: row.error,
    };
  });
  return {
    schema_version: GROK_OBSERVATION_SCHEMA_VERSION, observed_at_ms: nowMs,
    health: "ok", dependency: null, accounts, notes,
  };
}

export interface ObserveGrokOptions {
  env?: Record<string, string | undefined>;
  refresh?: boolean;
  account?: string;
}

export async function observeGrok(options: ObserveGrokOptions = {}): Promise<GrokObservation> {
  const env = options.env ?? process.env;
  const paths = statePaths(env);
  const deadlineMs = Date.now() + REFRESH_BUDGET_MS;
  try {
    const initial = await readState(paths);
    const targets = options.account === undefined
      ? initial.accounts.filter((account) => account.enabled)
      : [resolveAccount(initial, options.account)];
    if (options.account !== undefined && !targets[0]!.enabled)
      throw new GrokError("account_disabled", "The requested Grok account is disabled");
    const notes: string[] = [];
    for (const target of targets) {
      if (Date.now() >= deadlineMs) {
        notes.push("Grok refresh reached its time budget; remaining accounts retain their cached observations");
        break;
      }
      await withState(paths, async (state, persist) => {
        const account = state.accounts.find((row) => row.accountKey === target.accountKey && row.userId === target.userId);
        // A concurrent removal must not resurrect an account from the initial read.
        if (!account || !account.enabled) return { result: null, changed: false };
        const changed = await observeAccount(account, {
          force: options.refresh === true, env, deadlineMs, persistCredentials: persist,
        });
        return { result: null, changed };
      }, Math.max(0, Math.min(30_000, deadlineMs - Date.now())));
    }
    // A targeted refresh still publishes the complete inventory to the sidecar.
    return buildGrokObservation((await readState(paths)).accounts, Date.now(), notes);
  } catch (error) {
    const code = error instanceof AccountError ? error.code : "observation_failed";
    return {
      schema_version: GROK_OBSERVATION_SCHEMA_VERSION, observed_at_ms: Date.now(),
      health: code === "store_corrupt" || code === "invalid-state" ? "malformed" : "error",
      dependency: null, accounts: [], notes: [`Grok account observation failed (${code})`],
    };
  }
}
