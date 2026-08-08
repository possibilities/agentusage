import { closeSync, constants, fsyncSync, mkdirSync, openSync, readSync, fstatSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { FOCUS_LEAF_MAX_BYTES, OBSERVATION_FRESHNESS_CEILING_MS } from "./constants.ts";
import { FABLE_WINDOW_KEY, type Observation } from "./claude/types.ts";

/**
 * Fable / Non-Fable focus — keeper's policy contract, stored as hardened JSON
 * leaves written directly by the CLI (agentusage has no daemon event rail).
 * One whole policy per leaf; `{"schema_version":1,"policy":null}` means off.
 */

export const FOCUS_LEAF_SCHEMA_VERSION = 1;

export type AccountFocusLifetime = { kind: "permanent" } | { kind: "absolute"; deadline_at: string };

export type FableFocusLifetime = AccountFocusLifetime | { kind: "cycle-end"; reset_at: string };

export interface AccountFocusPolicy<TIntent extends boolean = boolean> {
  schema_version: 1;
  policy_id: string;
  target_route: string;
  fable_intent: TIntent;
  set_at: string;
  lifetime: AccountFocusLifetime;
}

export interface FableFocusPolicy extends Omit<AccountFocusPolicy<true>, "lifetime"> {
  lifetime: FableFocusLifetime;
}

export type NonFableFocusPolicy = AccountFocusPolicy<false>;

export type AccountFocusEffectiveState = "off" | "active" | "expired" | "invalid" | "unavailable";
export type FableFocusEffectiveState = AccountFocusEffectiveState | "completed";

export type FocusDeliveryDiagnostic =
  | "none"
  | "delivery-missing"
  | "delivery-malformed"
  | "delivery-unsupported"
  | "delivery-insecure"
  | "delivery-unreachable"
  | "policy-invalid";

export interface FocusDelivery<P> {
  available: boolean;
  policy: P | null;
  diagnostic: FocusDeliveryDiagnostic;
}

export interface FocusStatus<P, S> {
  state: S;
  policy: P | null;
  diagnostic: FocusDeliveryDiagnostic;
}

const ROUTE_PATTERN = /^claude-swap:([1-9]\d*)$/u;

export function normalizeRouteId(value: string): string | null {
  return ROUTE_PATTERN.test(value) ? value : null;
}

function normalizeUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(value)) return null;
  return new Date(ms).toISOString();
}

function validateLifetime(value: unknown, fable: boolean): AccountFocusLifetime | FableFocusLifetime | null {
  if (typeof value !== "object" || value === null) return null;
  const lifetime = value as Record<string, unknown>;
  if (lifetime.kind === "permanent") return { kind: "permanent" };
  if (lifetime.kind === "absolute") {
    const deadline = normalizeUtcTimestamp(lifetime.deadline_at);
    return deadline === null ? null : { kind: "absolute", deadline_at: deadline };
  }
  if (fable && lifetime.kind === "cycle-end") {
    const reset = normalizeUtcTimestamp(lifetime.reset_at);
    return reset === null ? null : { kind: "cycle-end", reset_at: reset };
  }
  return null;
}

export function validateFocusPolicy<T extends boolean>(value: unknown, fableIntent: T): AccountFocusPolicy<T> | null {
  if (typeof value !== "object" || value === null) return null;
  const policy = value as Record<string, unknown>;
  if (policy.schema_version !== 1) return null;
  if (typeof policy.policy_id !== "string" || policy.policy_id.length === 0) return null;
  if (typeof policy.target_route !== "string" || normalizeRouteId(policy.target_route) === null) return null;
  if (policy.fable_intent !== fableIntent) return null;
  const setAt = normalizeUtcTimestamp(policy.set_at);
  if (setAt === null) return null;
  const lifetime = validateLifetime(policy.lifetime, fableIntent);
  if (lifetime === null) return null;
  return value as AccountFocusPolicy<T>;
}

export function materializeFocusPolicy<T extends boolean>(
  targetRoute: string,
  lifetime: T extends true ? FableFocusLifetime : AccountFocusLifetime,
  fableIntent: T,
  nowMs: number,
): T extends true ? FableFocusPolicy : NonFableFocusPolicy {
  return {
    schema_version: 1,
    policy_id: `cli:${nowMs.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    target_route: targetRoute,
    fable_intent: fableIntent,
    set_at: new Date(nowMs).toISOString(),
    lifetime,
  } as T extends true ? FableFocusPolicy : NonFableFocusPolicy;
}

// ---------------------------------------------------------------------------
// Leaf IO

export function writeFocusLeaf(path: string, policy: unknown | null): void {
  const payload = `${JSON.stringify({ schema_version: FOCUS_LEAF_SCHEMA_VERSION, policy })}\n`;
  if (Buffer.byteLength(payload) > FOCUS_LEAF_MAX_BYTES) throw new Error("focus policy exceeds leaf size cap");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${process.pid}-focus.tmp`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readFocusLeaf<T extends boolean>(path: string, fableIntent: T): FocusDelivery<AccountFocusPolicy<T>> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { available: true, policy: null, diagnostic: "delivery-missing" };
    if (code === "ELOOP") return { available: false, policy: null, diagnostic: "delivery-insecure" };
    return { available: false, policy: null, diagnostic: "delivery-unreachable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { available: false, policy: null, diagnostic: "delivery-insecure" };
    if ((stat.mode & 0o077) !== 0) return { available: false, policy: null, diagnostic: "delivery-insecure" };
    if (stat.size > FOCUS_LEAF_MAX_BYTES) return { available: false, policy: null, diagnostic: "delivery-malformed" };
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return { available: false, policy: null, diagnostic: "delivery-malformed" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { available: false, policy: null, diagnostic: "delivery-malformed" };
    }
    const leaf = parsed as Record<string, unknown>;
    if (leaf.schema_version !== FOCUS_LEAF_SCHEMA_VERSION) {
      return { available: false, policy: null, diagnostic: "delivery-unsupported" };
    }
    if (leaf.policy === null) return { available: true, policy: null, diagnostic: "none" };
    const policy = validateFocusPolicy(leaf.policy, fableIntent);
    if (policy === null) return { available: false, policy: null, diagnostic: "policy-invalid" };
    return { available: true, policy, diagnostic: "none" };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Effective-state evaluation (pure, half-open deadlines)

export function isObservationFresh(observation: Observation, nowMs: number): boolean {
  return nowMs - observation.observed_at_ms <= OBSERVATION_FRESHNESS_CEILING_MS;
}

function matchingFableWindowCompleted(
  policy: FableFocusPolicy,
  observation: Observation | null,
  nowMs: number,
): boolean {
  if (policy.lifetime.kind !== "cycle-end" || observation === null) return false;
  if (observation.health !== "ok" || !isObservationFresh(observation, nowMs)) return false;
  const route = observation.routes.find((candidate) => candidate.id === policy.target_route);
  if (route === undefined) return false;
  const boundaryMs = Date.parse(policy.lifetime.reset_at);
  return route.windows.some((window) => {
    if (window.key.toLowerCase() !== FABLE_WINDOW_KEY) return false;
    if (window.resetsAt === null) return false;
    return Date.parse(window.resetsAt) === boundaryMs && window.utilization >= 1;
  });
}

export function effectiveNonFableFocus(
  delivery: FocusDelivery<NonFableFocusPolicy>,
  nowMs: number,
): FocusStatus<NonFableFocusPolicy, AccountFocusEffectiveState> {
  if (!delivery.available) return { state: "unavailable", policy: null, diagnostic: delivery.diagnostic };
  const policy = delivery.policy;
  if (policy === null) return { state: "off", policy: null, diagnostic: "none" };
  if (validateFocusPolicy(policy, false) === null || !Number.isFinite(nowMs)) {
    return { state: "invalid", policy: null, diagnostic: "policy-invalid" };
  }
  if (policy.lifetime.kind === "absolute") {
    return {
      state: nowMs < Date.parse(policy.lifetime.deadline_at) ? "active" : "expired",
      policy,
      diagnostic: "none",
    };
  }
  return { state: "active", policy, diagnostic: "none" };
}

export function effectiveFableFocus(
  delivery: FocusDelivery<FableFocusPolicy>,
  observation: Observation | null,
  nowMs: number,
): FocusStatus<FableFocusPolicy, FableFocusEffectiveState> {
  if (!delivery.available) return { state: "unavailable", policy: null, diagnostic: delivery.diagnostic };
  const policy = delivery.policy;
  if (policy === null) return { state: "off", policy: null, diagnostic: "none" };
  if (validateFocusPolicy(policy, true) === null || !Number.isFinite(nowMs)) {
    return { state: "invalid", policy: null, diagnostic: "policy-invalid" };
  }
  if (policy.lifetime.kind === "absolute") {
    return {
      state: nowMs < Date.parse(policy.lifetime.deadline_at) ? "active" : "expired",
      policy,
      diagnostic: "none",
    };
  }
  if (policy.lifetime.kind === "permanent") return { state: "active", policy, diagnostic: "none" };
  const completed =
    nowMs >= Date.parse(policy.lifetime.reset_at) || matchingFableWindowCompleted(policy, observation, nowMs);
  return { state: completed ? "completed" : "active", policy, diagnostic: "none" };
}

// ---------------------------------------------------------------------------
// current-reset / cycle-end construction from the live observation

export type CurrentResetFocusError =
  | "observation-unavailable"
  | "observation-stale"
  | "target-unavailable"
  | "reset-unavailable"
  | "reset-elapsed"
  | "reset-mismatch";

export type CurrentResetFocusResult =
  | { ok: true; resetAt: string }
  | { ok: false; error: CurrentResetFocusError };

/**
 * Resolves the observed Fable reset boundary for a target route. Refuses to
 * advance to a later cycle: an elapsed reset is an error, never a rollover.
 */
export function resolveObservedFableReset(
  observation: Observation | null,
  targetRoute: string,
  nowMs: number,
  expectReset: string | null,
): CurrentResetFocusResult {
  if (observation === null || observation.health !== "ok") return { ok: false, error: "observation-unavailable" };
  if (!isObservationFresh(observation, nowMs)) return { ok: false, error: "observation-stale" };
  const route = observation.routes.find((candidate) => candidate.id === targetRoute);
  if (route === undefined) return { ok: false, error: "target-unavailable" };
  const fable = route.windows.find((window) => window.key.toLowerCase() === FABLE_WINDOW_KEY);
  if (fable === undefined || fable.resetsAt === null) return { ok: false, error: "reset-unavailable" };
  const resetMs = Date.parse(fable.resetsAt);
  if (!Number.isFinite(resetMs)) return { ok: false, error: "reset-unavailable" };
  if (resetMs <= nowMs) return { ok: false, error: "reset-elapsed" };
  if (expectReset !== null) {
    const expected = Date.parse(expectReset);
    if (!Number.isFinite(expected) || expected !== resetMs) return { ok: false, error: "reset-mismatch" };
  }
  return { ok: true, resetAt: new Date(resetMs).toISOString() };
}
