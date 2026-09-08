import type { StatePaths } from "../paths.ts";
import type { Env } from "../accounts/http.ts";
import { AccountError, readPrivate } from "../accounts/storage.ts";
import type { StoreState } from "./model.ts";
import { GrokError } from "./model.ts";
import { login, type LoginOptions } from "./oauth.ts";
import { observeAccount, publicAccount, safeObservationError } from "./billing.ts";
import { assertAliasAvailable, assertState, emptyState, readState, resolveAccount, validateAlias, withState } from "./store.ts";

export async function listGrokAccounts(paths: StatePaths) {
  return (await readState(paths)).accounts.sort((a, b) => a.ordinal - b.ordinal).map(accountSummary);
}
function accountSummary(account: StoreState["accounts"][number]) {
  const view = publicAccount(account);
  return {
    key: view.accountKey, provider: "grok" as const, account_id: account.userId,
    ordinal: view.ordinal, email: view.email, label: view.alias, enabled: view.enabled,
    auth_error: view.authStatus === "error" ? "auth_unavailable" : null,
    auth_status: view.authStatus, expires_at_ms: account.credentials.expiresAtMs,
    usage_error: account.observation.error ? { code: safeObservationError(account.observation.error)!.code, status: null } : null,
  };
}

/** Explicit snapshot restore, also used for moving an existing Grok inventory.
 * No command discovers another owner's store or reads a native harness home.
 */
export async function importGrokState(paths: StatePaths, file: string) {
  const imported = readPrivate(file, (value) => { assertState(value); return value; }, () => {
    throw new AccountError("missing-file", "Grok account snapshot does not exist");
  });
  return withState(paths, (state) => {
    if (JSON.stringify(state) === JSON.stringify(imported))
      return { result: { accounts: state.accounts.map(accountSummary), imported: false }, changed: false };
    if (JSON.stringify(state) !== JSON.stringify(emptyState()))
      throw new AccountError("account-store-not-empty", "Grok snapshot restore requires an empty owned inventory; existing accounts were not changed");
    Object.assign(state, imported);
    return { result: { accounts: state.accounts.map(accountSummary), imported: true }, changed: true };
  });
}

export async function loginGrokAccount(
  paths: StatePaths,
  options: LoginOptions & { label?: string; account?: string },
) {
  const label = options.label === undefined ? undefined : validateAlias(options.label);
  // Resolve an explicit reauthentication target before waiting for the human.
  // Retain its identity across deletion/rename races during device login.
  const expected = options.account === undefined ? null : resolveAccount(await readState(paths), options.account);
  const authenticated = await login(options);
  return withState(paths, (state) => {
    const current = expected
      ? state.accounts.find((a) => a.accountKey === expected.accountKey && a.userId === expected.userId)
      : state.accounts.find((a) => a.userId === authenticated.userId);
    if (expected && (!current || current.userId !== authenticated.userId))
      throw new GrokError("identity_mismatch", "Reauthentication must keep the same existing xAI account");
    const now = new Date().toISOString();
    if (current) {
      current.credentials = authenticated.credentials;
      current.email = authenticated.email;
      if (label !== undefined) current.alias = label;
      current.observation.error = null;
      current.observation.failureCount = 0;
      current.observation.nextAttemptAtMs = null;
      current.updatedAt = now;
      assertAliasAvailable(state, current);
      return { result: accountSummary(current), changed: true };
    }
    if (state.accounts.length >= 100) throw new GrokError("account_limit", "At most 100 Grok accounts are supported");
    const ordinal = state.nextOrdinal++;
    const account: StoreState["accounts"][number] = {
      accountKey: `grok-${ordinal}`, displayName: `grok-${ordinal}`, ordinal,
      alias: label ?? null, email: authenticated.email, userId: authenticated.userId,
      enabled: true, credentials: authenticated.credentials,
      observation: { lastGood: null, lastAttemptAt: null, failureCount: 0, nextAttemptAtMs: null, error: null },
      createdAt: now, updatedAt: now,
    };
    assertAliasAvailable(state, account);
    state.accounts.push(account);
    return { result: accountSummary(account), changed: true };
  });
}

export async function changeGrokAccount(
  paths: StatePaths,
  action: "enable" | "disable" | "remove" | "label",
  selector: string,
  label?: string | null,
) {
  return withState(paths, (state) => {
    const account = resolveAccount(state, selector);
    if (action === "label") {
      if (label === undefined) throw new GrokError("missing_label", "Account label requires --label TEXT");
      account.alias = label === null ? null : validateAlias(label);
      assertAliasAvailable(state, account);
    } else if (action === "remove") {
      state.accounts = state.accounts.filter((a) => a !== account);
      state.reservations = state.reservations.filter((r) => r.accountKey !== account.accountKey);
    } else {
      account.enabled = action === "enable";
      if (!account.enabled) state.reservations = state.reservations.filter((r) => r.accountKey !== account.accountKey);
    }
    account.updatedAt = new Date().toISOString();
    return { result: { account: accountSummary(account), removed: action === "remove" }, changed: true };
  });
}

export async function recoverGrokAccount(paths: StatePaths, selector: string, env: Env = process.env) {
  const result = await withState(paths, async (state, persist) => {
    const account = resolveAccount(state, selector);
    if (!account.enabled) throw new GrokError("account_disabled", "Grok account is disabled");
    await observeAccount(account, { force: true, env, persistCredentials: persist });
    return { result: { account: accountSummary(account), error: account.observation.error }, changed: true };
  });
  if (result.error) throw new GrokError(result.error.code, result.error.message);
  return result.account;
}
