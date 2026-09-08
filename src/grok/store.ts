import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { StatePaths } from "../paths.ts";
import { checkPrivateDirectory, privateDirectory, readPrivate, withLock, writePrivate } from "../accounts/storage.ts";
import { accountDirectory } from "../accounts/store.ts";
import type { StoreState, StoredAccount } from "./model.ts";
import { GrokError } from "./model.ts";
import { XAI_ISSUER, XAI_CLIENT_ID } from "./oauth.ts";

export const statePath = (paths: StatePaths): string => join(accountDirectory(paths), "grok.json");
export const lockPath = (paths: StatePaths): string => join(accountDirectory(paths), "grok.lock");
export const emptyState = (): StoreState => ({ version: 1, nextOrdinal: 1, nextAvailableCursor: null, accounts: [], reservations: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertState(value: unknown): asserts value is StoreState {
  if (
    !isRecord(value) || value.version !== 1 ||
    !Number.isSafeInteger(value.nextOrdinal) || (value.nextOrdinal as number) < 1 ||
    !(value.nextAvailableCursor === null || Number.isSafeInteger(value.nextAvailableCursor)) ||
    !Array.isArray(value.accounts) || value.accounts.length > 100 || !Array.isArray(value.reservations) || value.reservations.length > 100
  ) {
    throw new GrokError("store_corrupt", "The Grok account state file is invalid; it was not overwritten");
  }
  const keys = new Set<string>();
  const ordinals = new Set<number>();
  const identities = new Set<string>();
  let maximumOrdinal = 0;
  for (const account of value.accounts) {
    if (!isRecord(account)) corrupt("account store");
    const ordinal = account.ordinal;
    const accountKey = account.accountKey;
    const userId = account.userId;
    if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 1 ||
      accountKey !== `grok-${ordinal as number}` || account.displayName !== accountKey ||
      typeof userId !== "string" || userId.length < 1 || userId.length > 1024 || /[\x00-\x1f\x7f]/u.test(userId) ||
      !(account.alias === null || plainString(account.alias, 80)) ||
      !(account.email === null || plainString(account.email, 1024)) || typeof account.enabled !== "boolean" ||
      !validIso(account.createdAt) || !validIso(account.updatedAt)
    ) corrupt("account store");
    if (keys.has(accountKey as string) || ordinals.has(ordinal as number) || identities.has(userId as string)) corrupt("account identities");
    keys.add(accountKey as string);
    ordinals.add(ordinal as number);
    identities.add(userId as string);
    maximumOrdinal = Math.max(maximumOrdinal, ordinal as number);
    const credentials = account.credentials;
    if (!isRecord(credentials) || !tokenString(credentials.accessToken) || !tokenString(credentials.refreshToken) ||
      credentials.issuer !== XAI_ISSUER || credentials.clientId !== XAI_CLIENT_ID ||
      typeof credentials.expiresAtMs !== "number" || !Number.isFinite(new Date(credentials.expiresAtMs).getTime())) corrupt("credential store");
    assertObservation(account.observation);
  }
  if ((value.nextOrdinal as number) <= maximumOrdinal) corrupt("next account ordinal");
  if (value.nextAvailableCursor !== null && ((value.nextAvailableCursor as number) < 1 || (value.nextAvailableCursor as number) >= (value.nextOrdinal as number))) corrupt("selection cursor");
  const reservationIds = new Set<string>();
  for (const reservation of value.reservations) {
    if (!isRecord(reservation) || typeof reservation.id !== "string" || typeof reservation.accountKey !== "string" ||
      typeof reservation.createdAtMs !== "number" || !Number.isFinite(reservation.createdAtMs) ||
      typeof reservation.expiresAtMs !== "number" || !Number.isFinite(reservation.expiresAtMs) ||
      reservation.expiresAtMs <= reservation.createdAtMs || reservation.expiresAtMs - reservation.createdAtMs > 300_000) corrupt("reservation store");
    if (!keys.has(reservation.accountKey) || reservationIds.has(reservation.id)) corrupt("reservation identities");
    reservationIds.add(reservation.id);
  }
}

function assertObservation(value: unknown): void {
  if (!isRecord(value) || !(value.lastAttemptAt === null || validIso(value.lastAttemptAt)) ||
    typeof value.failureCount !== "number" || !Number.isSafeInteger(value.failureCount) || value.failureCount < 0 ||
    !(value.nextAttemptAtMs === null || (typeof value.nextAttemptAtMs === "number" && Number.isFinite(value.nextAttemptAtMs))) ||
    !(value.error === null || (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"))) {
    corrupt("observation store");
  }
  if (value.lastGood === null) return;
  if (!isRecord(value.lastGood) || !validIso(value.lastGood.observedAt) ||
    !isRecord(value.lastGood.included) || !nullableNumber(value.lastGood.included.usedPercent) || !nullableNumber(value.lastGood.included.remainingPercent) ||
    !nullableString(value.lastGood.included.periodType) || !nullableString(value.lastGood.included.periodStart) || !nullableString(value.lastGood.included.resetsAt) ||
    !isRecord(value.lastGood.prepaid) || !nullableNumber(value.lastGood.prepaid.balanceUsd) ||
    !isRecord(value.lastGood.payg) || !(value.lastGood.payg.enabled === null || typeof value.lastGood.payg.enabled === "boolean") ||
    !nullableNumber(value.lastGood.payg.usedUsd) || !nullableNumber(value.lastGood.payg.capUsd) || !nullableNumber(value.lastGood.payg.remainingUsd) ||
    !nullableString(value.lastGood.subscriptionTier)) corrupt("last-good observation");
}

function nullableNumber(value: unknown): boolean { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function plainString(value: unknown, limit = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value);
}
function tokenString(value: unknown): value is string { return value === "" || plainString(value, 65_535); }
function nullableString(value: unknown): boolean { return value === null || plainString(value); }
function validIso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function corrupt(label: string): never { throw new GrokError("store_corrupt", `The Grok account ${label} is invalid; it was not overwritten`); }

async function validateExistingComponents(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new GrokError("store_unsafe", "The Grok account state root must be absolute");
  const parts = path.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let metadata;
    try { metadata = await lstat(current); } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw new GrokError("store_unsafe", "A Grok account state path component could not be inspected");
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current).catch(() => "");
      const darwinAlias = process.platform === "darwin" &&
        ((current === "/var" && (target === "private/var" || target === "/private/var")) ||
          (current === "/tmp" && (target === "private/tmp" || target === "/private/tmp")));
      if (darwinAlias) continue;
      throw new GrokError("store_unsafe", `The Grok account state path contains a symlink: ${current}`);
    }
    if (!metadata.isDirectory()) throw new GrokError("store_unsafe", `The Grok account state path contains a non-directory: ${current}`);
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid) {
      throw new GrokError("store_unsafe", `The Grok account state path has a foreign owner: ${current}`);
    }
    const worldWritable = (metadata.mode & 0o002) !== 0;
    const sticky = (metadata.mode & 0o1000) !== 0;
    if (worldWritable && !sticky) throw new GrokError("store_unsafe", `The Grok account state path is unsafely writable: ${current}`);
  }
}


function validatedState(value: unknown): StoreState {
  assertState(value);
  return value;
}

export async function readState(paths: StatePaths): Promise<StoreState> {
  await validateExistingComponents(accountDirectory(paths));
  checkPrivateDirectory(paths.stateRoot);
  return readPrivate(statePath(paths), validatedState, emptyState);
}

/** Grok shares AgentUsage's durable writes and kernel locks, with its own provider leaf. */
export async function withState<T>(
  paths: StatePaths,
  operation: (state: StoreState, persist: () => void) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  waitMs = 30_000,
): Promise<T> {
  await validateExistingComponents(accountDirectory(paths));
  privateDirectory(paths.stateRoot);
  return withLock(lockPath(paths), async () => {
    const state = await readState(paths);
    const persist = () => { assertState(state); writePrivate(statePath(paths), state); };
    const { result, changed } = await operation(state, persist);
    if (changed) persist();
    return result;
  }, waitMs);
}

export function resolveAccount(state: StoreState, reference: string): StoredAccount {
  const exact = state.accounts.filter((account) =>
    String(account.ordinal) === reference || account.userId === reference || account.accountKey === reference || account.displayName === reference || account.alias === reference || account.email === reference
  );
  if (exact.length === 0) {
    throw new GrokError("account_not_found", `No Grok account matches ${JSON.stringify(reference)}`, { accountKey: reference });
  }
  if (exact.length > 1) {
    throw new GrokError("account_ambiguous", `More than one Grok account matches ${JSON.stringify(reference)}`, {
      accountKey: reference,
      matches: exact.map((account) => account.accountKey),
    });
  }
  return exact[0]!;
}

export function validateAlias(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length < 1 || trimmed.length > 80 || /[\x00-\x1f\x7f]/u.test(trimmed)) {
    throw new GrokError("invalid_alias", "Alias must be 1-80 characters without control characters");
  }
  return trimmed;
}

/** Aliases may not shadow another account's stable or human identifiers. */
export function assertAliasAvailable(state: StoreState, candidate: StoredAccount): void {
  const matches = (account: StoredAccount, reference: string) =>
    [account.accountKey, String(account.ordinal), account.userId, account.alias, account.email].includes(reference);
  const collision = state.accounts.find((other) => other.accountKey !== candidate.accountKey && (
    (candidate.alias !== null && matches(other, candidate.alias)) ||
    (other.alias !== null && matches(candidate, other.alias))
  ));
  if (collision) throw new GrokError("alias_conflict", `The label would make account references ambiguous with ${collision.accountKey}`);
}


function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
