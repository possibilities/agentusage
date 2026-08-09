import { closeSync, constants, fsyncSync, mkdirSync, openSync, readSync, fstatSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  FOCUS_LEAF_MAX_BYTES,
  OBSERVATION_FRESHNESS_CEILING_MS,
} from "./constants.ts";
import { FABLE_WINDOW_KEY, WEEK_WINDOW, type Observation } from "./claude/types.ts";
import { MAIN_LANE_ID, type CodexObservation } from "./codex/types.ts";

/**
 * Fable / Non-Fable focus — keeper's policy contract, stored as hardened JSON
 * leaves written directly by the CLI (agentusage has no daemon event rail).
 * One whole policy per leaf; `{"schema_version":1,"policy":null}` means off.
 *
 * The provider-wide focus (`focus claude` / `focus codex`) is an agentusage
 * extension beyond keeper: one leaf per provider pinning every launch to one
 * account, overriding the intent focuses. Its observed lifetimes read the
 * binding weekly window (claude `week`, codex main-lane secondary), not the
 * Fable window.
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

export type FocusProvider = "claude" | "codex";

export type FullFocusLifetime = AccountFocusLifetime | { kind: "cycle-end"; reset_at: string };

/** Provider-wide pin: `target` is a claude route id or a codex accountKey. */
export interface FullFocusPolicy {
  schema_version: 1;
  policy_id: string;
  provider: FocusProvider;
  target: string;
  set_at: string;
  lifetime: FullFocusLifetime;
}

export type AccountFocusEffectiveState = "off" | "active" | "expired" | "invalid" | "unavailable";
export type FableFocusEffectiveState = AccountFocusEffectiveState | "completed";
export type FullFocusEffectiveState = FableFocusEffectiveState;

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

function validateLifetime(value: unknown, cycleEnd: boolean): AccountFocusLifetime | FableFocusLifetime | null {
  if (typeof value !== "object" || value === null) return null;
  const lifetime = value as Record<string, unknown>;
  if (lifetime.kind === "permanent") return { kind: "permanent" };
  if (lifetime.kind === "absolute") {
    const deadline = normalizeUtcTimestamp(lifetime.deadline_at);
    return deadline === null ? null : { kind: "absolute", deadline_at: deadline };
  }
  if (cycleEnd && lifetime.kind === "cycle-end") {
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

export function validateFullFocusPolicy(value: unknown, provider: FocusProvider): FullFocusPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const policy = value as Record<string, unknown>;
  if (policy.schema_version !== 1) return null;
  if (typeof policy.policy_id !== "string" || policy.policy_id.length === 0) return null;
  if (policy.provider !== provider) return null;
  if (typeof policy.target !== "string" || policy.target.length === 0) return null;
  if (provider === "claude" && normalizeRouteId(policy.target) === null) return null;
  if (normalizeUtcTimestamp(policy.set_at) === null) return null;
  if (validateLifetime(policy.lifetime, true) === null) return null;
  return value as FullFocusPolicy;
}

export function materializeFullFocusPolicy(
  provider: FocusProvider,
  target: string,
  lifetime: FullFocusLifetime,
  nowMs: number,
): FullFocusPolicy {
  return {
    schema_version: 1,
    policy_id: `cli:${nowMs.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    provider,
    target,
    set_at: new Date(nowMs).toISOString(),
    lifetime,
  };
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

type RawLeafRead =
  | { status: "unavailable"; diagnostic: FocusDeliveryDiagnostic }
  | { status: "missing" }
  | { status: "off" }
  | { status: "policy"; raw: unknown };

function readLeafRaw(path: string): RawLeafRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    if (code === "ELOOP") return { status: "unavailable", diagnostic: "delivery-insecure" };
    return { status: "unavailable", diagnostic: "delivery-unreachable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: "unavailable", diagnostic: "delivery-insecure" };
    if ((stat.mode & 0o077) !== 0) return { status: "unavailable", diagnostic: "delivery-insecure" };
    if (stat.size > FOCUS_LEAF_MAX_BYTES) return { status: "unavailable", diagnostic: "delivery-malformed" };
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
      return { status: "unavailable", diagnostic: "delivery-malformed" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "unavailable", diagnostic: "delivery-malformed" };
    }
    const leaf = parsed as Record<string, unknown>;
    if (leaf.schema_version !== FOCUS_LEAF_SCHEMA_VERSION) {
      return { status: "unavailable", diagnostic: "delivery-unsupported" };
    }
    if (leaf.policy === null) return { status: "off" };
    return { status: "policy", raw: leaf.policy };
  } finally {
    closeSync(fd);
  }
}

export function readFocusLeaf<T extends boolean>(path: string, fableIntent: T): FocusDelivery<AccountFocusPolicy<T>> {
  const read = readLeafRaw(path);
  if (read.status === "unavailable") return { available: false, policy: null, diagnostic: read.diagnostic };
  if (read.status === "missing") return { available: true, policy: null, diagnostic: "delivery-missing" };
  if (read.status === "off") return { available: true, policy: null, diagnostic: "none" };
  const policy = validateFocusPolicy(read.raw, fableIntent);
  if (policy === null) return { available: false, policy: null, diagnostic: "policy-invalid" };
  return { available: true, policy, diagnostic: "none" };
}

export function readFullFocusLeaf(path: string, provider: FocusProvider): FocusDelivery<FullFocusPolicy> {
  const read = readLeafRaw(path);
  if (read.status === "unavailable") return { available: false, policy: null, diagnostic: read.diagnostic };
  if (read.status === "missing") return { available: true, policy: null, diagnostic: "delivery-missing" };
  if (read.status === "off") return { available: true, policy: null, diagnostic: "none" };
  const policy = validateFullFocusPolicy(read.raw, provider);
  if (policy === null) return { available: false, policy: null, diagnostic: "policy-invalid" };
  return { available: true, policy, diagnostic: "none" };
}

// ---------------------------------------------------------------------------
// Effective-state evaluation (pure, half-open deadlines)

export function isObservationFresh(observation: Observation, nowMs: number): boolean {
  return nowMs - observation.observed_at_ms <= OBSERVATION_FRESHNESS_CEILING_MS;
}

export function isCodexObservationFresh(observation: CodexObservation, nowMs: number): boolean {
  return nowMs - observation.observed_at_ms <= CODEX_OBSERVATION_FRESHNESS_CEILING_MS;
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
// Provider-wide focus: effective state reads the binding weekly window

function claudeWeekWindowCompleted(policy: FullFocusPolicy, observation: Observation | null, nowMs: number): boolean {
  if (policy.lifetime.kind !== "cycle-end" || observation === null) return false;
  if (observation.health !== "ok" || !isObservationFresh(observation, nowMs)) return false;
  const route = observation.routes.find((candidate) => candidate.id === policy.target);
  if (route === undefined) return false;
  const boundaryMs = Date.parse(policy.lifetime.reset_at);
  return route.windows.some((window) => {
    if (window.key !== WEEK_WINDOW || window.resetsAt === null) return false;
    return Date.parse(window.resetsAt) === boundaryMs && window.utilization >= 1;
  });
}

function codexWeeklyWindowCompleted(
  policy: FullFocusPolicy,
  observation: CodexObservation | null,
  nowMs: number,
): boolean {
  if (policy.lifetime.kind !== "cycle-end" || observation === null) return false;
  if (observation.health !== "ok" || !isCodexObservationFresh(observation, nowMs)) return false;
  const account = observation.accounts.find((candidate) => candidate.accountKey === policy.target);
  const lane = account?.lanes.find((candidate) => candidate.id === MAIN_LANE_ID);
  if (lane === undefined) return false;
  const boundaryMs = Date.parse(policy.lifetime.reset_at);
  return lane.windows.some((window) => {
    if (window.role !== "secondary" || window.resetsAt === null) return false;
    return Date.parse(window.resetsAt) === boundaryMs && window.remainingPercent <= 0;
  });
}

function effectiveFullFocusCore(
  delivery: FocusDelivery<FullFocusPolicy>,
  provider: FocusProvider,
  nowMs: number,
  windowCompleted: (policy: FullFocusPolicy) => boolean,
): FocusStatus<FullFocusPolicy, FullFocusEffectiveState> {
  if (!delivery.available) return { state: "unavailable", policy: null, diagnostic: delivery.diagnostic };
  const policy = delivery.policy;
  if (policy === null) return { state: "off", policy: null, diagnostic: "none" };
  if (validateFullFocusPolicy(policy, provider) === null || !Number.isFinite(nowMs)) {
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
  const completed = nowMs >= Date.parse(policy.lifetime.reset_at) || windowCompleted(policy);
  return { state: completed ? "completed" : "active", policy, diagnostic: "none" };
}

export function effectiveClaudeFullFocus(
  delivery: FocusDelivery<FullFocusPolicy>,
  observation: Observation | null,
  nowMs: number,
): FocusStatus<FullFocusPolicy, FullFocusEffectiveState> {
  return effectiveFullFocusCore(delivery, "claude", nowMs, (policy) =>
    claudeWeekWindowCompleted(policy, observation, nowMs),
  );
}

export function effectiveCodexFullFocus(
  delivery: FocusDelivery<FullFocusPolicy>,
  observation: CodexObservation | null,
  nowMs: number,
): FocusStatus<FullFocusPolicy, FullFocusEffectiveState> {
  return effectiveFullFocusCore(delivery, "codex", nowMs, (policy) =>
    codexWeeklyWindowCompleted(policy, observation, nowMs),
  );
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
 * Shared boundary arithmetic: refuses to advance to a later cycle — an
 * elapsed reset is an error, never a rollover.
 */
function resolveResetBoundary(
  resetsAt: string | null | undefined,
  nowMs: number,
  expectReset: string | null,
): CurrentResetFocusResult {
  if (resetsAt == null) return { ok: false, error: "reset-unavailable" };
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return { ok: false, error: "reset-unavailable" };
  if (resetMs <= nowMs) return { ok: false, error: "reset-elapsed" };
  if (expectReset !== null) {
    const expected = Date.parse(expectReset);
    if (!Number.isFinite(expected) || expected !== resetMs) return { ok: false, error: "reset-mismatch" };
  }
  return { ok: true, resetAt: new Date(resetMs).toISOString() };
}

function resolveClaudeWindowReset(
  observation: Observation | null,
  targetRoute: string,
  nowMs: number,
  expectReset: string | null,
  windowKey: string,
): CurrentResetFocusResult {
  if (observation === null || observation.health !== "ok") return { ok: false, error: "observation-unavailable" };
  if (!isObservationFresh(observation, nowMs)) return { ok: false, error: "observation-stale" };
  const route = observation.routes.find((candidate) => candidate.id === targetRoute);
  if (route === undefined) return { ok: false, error: "target-unavailable" };
  const window = route.windows.find((candidate) => candidate.key.toLowerCase() === windowKey);
  return resolveResetBoundary(window?.resetsAt, nowMs, expectReset);
}

export function resolveObservedFableReset(
  observation: Observation | null,
  targetRoute: string,
  nowMs: number,
  expectReset: string | null,
): CurrentResetFocusResult {
  return resolveClaudeWindowReset(observation, targetRoute, nowMs, expectReset, FABLE_WINDOW_KEY);
}

/** Weekly boundary for the provider-wide focus's observed lifetimes. */
export function resolveObservedWeekReset(
  observation: Observation | null,
  targetRoute: string,
  nowMs: number,
  expectReset: string | null,
): CurrentResetFocusResult {
  return resolveClaudeWindowReset(observation, targetRoute, nowMs, expectReset, WEEK_WINDOW);
}

export function resolveObservedCodexWeeklyReset(
  observation: CodexObservation | null,
  accountKey: string,
  nowMs: number,
  expectReset: string | null,
): CurrentResetFocusResult {
  if (observation === null || observation.health !== "ok") return { ok: false, error: "observation-unavailable" };
  if (!isCodexObservationFresh(observation, nowMs)) return { ok: false, error: "observation-stale" };
  const account = observation.accounts.find((candidate) => candidate.accountKey === accountKey);
  if (account === undefined) return { ok: false, error: "target-unavailable" };
  const lane = account.lanes.find((candidate) => candidate.id === MAIN_LANE_ID);
  const weekly = lane?.windows.find((window) => window.role === "secondary");
  return resolveResetBoundary(weekly?.resetsAt, nowMs, expectReset);
}
