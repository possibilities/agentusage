import {
  MAX_LEDGER_ROUTES,
  MAX_RESERVATIONS_PER_ROUTE,
  OBSERVATION_FRESHNESS_CEILING_MS,
  RESERVATION_TTL_MS,
  RESERVATION_UTILIZATION_STEP,
} from "../constants.ts";
import {
  FABLE_WINDOW_KEY,
  MODEL_WINDOW_PREFIX,
  displayNameForRouteId,
  type Observation,
  type Route,
  routeIdForSlot,
  SESSION_WINDOW,
  WEEK_WINDOW,
} from "../claude/types.ts";
import type { StatePaths } from "../paths.ts";
import { readSidecar, writeSidecar } from "../sidecar.ts";
import {
  type AccountFocusEffectiveState,
  type FableFocusEffectiveState,
  type FableFocusPolicy,
  type FullFocusEffectiveState,
  type FullFocusPolicy,
  type NonFableFocusPolicy,
  effectiveClaudeFullFocus,
  effectiveFableFocus,
  effectiveNonFableFocus,
  readFocusLeaf,
  readFullFocusLeaf,
} from "../focus.ts";
import { acquirePathLock, releasePathLock } from "./lock.ts";

/**
 * Keeper's Claude account selection, ported: eligibility gate, Fable
 * conservation scoring, reservation pressure, deterministic tie-breaks,
 * focus overlay. Reasons and issue names keep keeper's vocabulary.
 */

export type LaunchRouteIssue =
  | "session-quota-missing"
  | "session-quota-exhausted"
  | "weekly-quota-missing"
  | "weekly-quota-exhausted"
  | "fable-entitlement-missing"
  | "fable-quota-exhausted";

export type SelectionReason =
  | "full-focus"
  | "full-focus-fallback"
  | "fable-focus"
  | "non-fable-focus"
  | "fable-focus-avoided"
  | "fable-focus-fallback"
  | "non-fable-focus-fallback"
  | "sole-candidate"
  | "selected"
  | "requested-account";

export type SelectionRefusal =
  | "observation-unavailable"
  | "observation-stale"
  | "no-eligible-account"
  | "requested-unknown"
  | "requested-ineligible";

const LEDGER_SCHEMA_VERSION = 2;

interface LedgerEntry {
  reservations: number[];
  last_selected_at: number;
}

interface Ledger {
  schema_version: number;
  routes: Record<string, LedgerEntry>;
}

export interface RouteScore {
  fableTier: number;
  fablePreference: number;
  genericPressure: number;
}

export interface ScoredCandidate {
  id: string;
  slot: number;
  score: RouteScore;
  pendingReservations: number;
  lastSelectedAtMs: number | null;
}

export interface ClaudeSelectionSuccess {
  ok: true;
  route: Route;
  /** Operator-facing `claude-<slot>` name for the chosen route. */
  display_name: string;
  /** Zero-based position in cswap inventory order; bookkeeping, not display. */
  ordinal: number | null;
  reason: SelectionReason;
  fableIntent: boolean;
  observationAgeMs: number;
  focus: { full: FullFocusEffectiveState; fable: FableFocusEffectiveState; nonFable: AccountFocusEffectiveState };
  pool: ScoredCandidate[];
  excluded: Record<string, LaunchRouteIssue[]>;
  reserved: boolean;
}

export interface ClaudeSelectionRefusal {
  ok: false;
  refusal: SelectionRefusal;
  detail: string;
  excluded: Record<string, LaunchRouteIssue[]>;
}

export type ClaudeSelection = ClaudeSelectionSuccess | ClaudeSelectionRefusal;

// ---------------------------------------------------------------------------
// Window arithmetic

function worstUtilizationForKey(route: Route, key: string): number | null {
  let worst: number | null = null;
  for (const window of route.windows) {
    if (window.key !== key) continue;
    if (worst === null || window.utilization > worst) worst = window.utilization;
  }
  return worst;
}

export function fableUtilization(route: Route): number | null {
  let worst: number | null = null;
  for (const window of route.windows) {
    if (window.key.toLowerCase() !== FABLE_WINDOW_KEY) continue;
    if (worst === null || window.utilization > worst) worst = window.utilization;
  }
  return worst;
}

export function isFableRequest(model: string | null | undefined, fableIntent?: boolean | null): boolean {
  if (typeof fableIntent === "boolean") return fableIntent;
  if (typeof model === "string" && model.length > 0) {
    const normalized = model.trim().toLowerCase();
    return normalized.includes("fable") || /(?:-1m|\[1m\])$/u.test(normalized);
  }
  return false;
}

export function routeIssues(route: Route, model: string | null | undefined, fableIntent?: boolean | null): LaunchRouteIssue[] {
  const issues: LaunchRouteIssue[] = [];
  const session = worstUtilizationForKey(route, SESSION_WINDOW);
  const week = worstUtilizationForKey(route, WEEK_WINDOW);
  if (session === null) issues.push("session-quota-missing");
  else if (session >= 1) issues.push("session-quota-exhausted");
  if (week === null) issues.push("weekly-quota-missing");
  else if (week >= 1) issues.push("weekly-quota-exhausted");
  if (isFableRequest(model, fableIntent)) {
    const fable = fableUtilization(route);
    if (fable === null) issues.push("fable-entitlement-missing");
    else if (fable >= 1) issues.push("fable-quota-exhausted");
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Scoring — the conservation heart; the branch asymmetry is deliberate.

function genericPressure(route: Route, pending: number): number {
  let worst = 0;
  for (const window of route.windows) {
    if (window.key.startsWith(MODEL_WINDOW_PREFIX)) continue;
    if (window.utilization > worst) worst = window.utilization;
  }
  return worst + pending * RESERVATION_UTILIZATION_STEP;
}

export function routeScore(
  route: Route,
  pending: number,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): RouteScore {
  const fable = fableUtilization(route);
  const pressure = genericPressure(route, pending);
  if (isFableRequest(model, fableIntent)) {
    return {
      fableTier: 0,
      // Raw Fable percentage is authoritative; reservations and generic
      // pressure may break only an equal Fable percentage.
      fablePreference: fable ?? 1,
      genericPressure: pressure,
    };
  }
  return {
    // No Fable entitlement is the strongest conservation signal.
    fableTier: fable === null ? 0 : 1,
    // Among Fable-bearing accounts, consume generic quota where the least
    // Fable capacity remains (greatest utilization).
    fablePreference: fable === null ? 0 : -fable,
    genericPressure: pressure,
  };
}

function compareScores(a: RouteScore, b: RouteScore): number {
  if (a.fableTier !== b.fableTier) return a.fableTier - b.fableTier;
  if (a.fablePreference !== b.fablePreference) return a.fablePreference - b.fablePreference;
  return a.genericPressure - b.genericPressure;
}

function scoreAndPick(
  candidates: readonly Route[],
  ledger: Ledger,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): Route {
  let best: Route | null = null;
  let bestScore: RouteScore | null = null;
  let bestLastSelected = Number.POSITIVE_INFINITY;
  for (const route of candidates) {
    const entry = ledger.routes[route.id];
    const pending = entry?.reservations.length ?? 0;
    const lastSelected = entry?.last_selected_at ?? Number.NEGATIVE_INFINITY;
    const score = routeScore(route, pending, model, fableIntent);
    const scoreOrder = bestScore === null ? -1 : compareScores(score, bestScore);
    if (
      best === null ||
      scoreOrder < 0 ||
      (scoreOrder === 0 && lastSelected < bestLastSelected) ||
      (scoreOrder === 0 && lastSelected === bestLastSelected && route.id < best.id)
    ) {
      best = route;
      bestScore = score;
      bestLastSelected = lastSelected;
    }
  }
  return best as Route;
}

// ---------------------------------------------------------------------------
// Reservation ledger

function emptyLedger(): Ledger {
  return { schema_version: LEDGER_SCHEMA_VERSION, routes: {} };
}

function validateLedger(value: unknown): Ledger | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== LEDGER_SCHEMA_VERSION) return null;
  if (typeof raw.routes !== "object" || raw.routes === null) return null;
  const routes: Record<string, LedgerEntry> = {};
  for (const [id, candidate] of Object.entries(raw.routes as Record<string, unknown>)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    const reservations = Array.isArray(entry.reservations)
      ? entry.reservations.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts))
      : [];
    const last =
      typeof entry.last_selected_at === "number" && Number.isFinite(entry.last_selected_at)
        ? entry.last_selected_at
        : Number.NEGATIVE_INFINITY;
    routes[id] = { reservations, last_selected_at: last };
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

function pruneLedger(ledger: Ledger, nowMs: number): Ledger {
  const routes: Record<string, LedgerEntry> = {};
  for (const [id, entry] of Object.entries(ledger.routes)) {
    routes[id] = {
      reservations: entry.reservations.filter((ts) => nowMs - ts <= RESERVATION_TTL_MS).slice(-MAX_RESERVATIONS_PER_ROUTE),
      last_selected_at: entry.last_selected_at,
    };
  }
  const ids = Object.keys(routes);
  if (ids.length > MAX_LEDGER_ROUTES) {
    const evict = ids
      .sort((a, b) => routes[a]!.last_selected_at - routes[b]!.last_selected_at)
      .slice(0, ids.length - MAX_LEDGER_ROUTES);
    for (const id of evict) delete routes[id];
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

function loadLedger(path: string): Ledger {
  const read = readSidecar(path, validateLedger);
  return read.value ?? emptyLedger();
}

function recordReservation(ledger: Ledger, routeId: string, nowMs: number): void {
  const entry = ledger.routes[routeId] ?? { reservations: [], last_selected_at: Number.NEGATIVE_INFINITY };
  entry.reservations = [...entry.reservations, nowMs].slice(-MAX_RESERVATIONS_PER_ROUTE);
  entry.last_selected_at = nowMs;
  ledger.routes[routeId] = entry;
}

/**
 * JSON serialization drops -Infinity last_selected_at markers to null; the
 * validator maps them back. Keep the write shape explicit so the file stays
 * hand-readable.
 */
function serializeLedger(ledger: Ledger): unknown {
  const routes: Record<string, { reservations: number[]; last_selected_at: number }> = {};
  for (const [id, entry] of Object.entries(ledger.routes)) {
    routes[id] = {
      reservations: entry.reservations,
      last_selected_at: Number.isFinite(entry.last_selected_at) ? entry.last_selected_at : 0,
    };
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

// ---------------------------------------------------------------------------
// Focus overlay + selection

interface FocusViews {
  intent: boolean;
  fullState: FullFocusEffectiveState;
  fableState: FableFocusEffectiveState;
  nonFableState: AccountFocusEffectiveState;
  fullPolicy: FullFocusPolicy | null;
  fablePolicy: FableFocusPolicy | null;
  nonFablePolicy: NonFableFocusPolicy | null;
}

function readFocusViews(paths: StatePaths, observation: Observation, nowMs: number, intent: boolean): FocusViews {
  const fullDelivery = readFullFocusLeaf(paths.claudeFullFocusLeaf, "claude");
  const fableDelivery = readFocusLeaf(paths.fableFocusLeaf, true) as import("../focus.ts").FocusDelivery<FableFocusPolicy>;
  const nonFableDelivery = readFocusLeaf(paths.nonFableFocusLeaf, false);
  const full = effectiveClaudeFullFocus(fullDelivery, observation, nowMs);
  const fable = effectiveFableFocus(fableDelivery, observation, nowMs);
  const nonFable = effectiveNonFableFocus(nonFableDelivery, nowMs);
  return {
    intent,
    fullState: full.state,
    fableState: fable.state,
    nonFableState: nonFable.state,
    fullPolicy: full.state === "active" ? full.policy : null,
    fablePolicy: fable.state === "active" ? fable.policy : null,
    nonFablePolicy: nonFable.state === "active" ? nonFable.policy : null,
  };
}

export interface SelectClaudeOptions {
  observation: Observation;
  paths: StatePaths;
  nowMs?: number;
  model?: string | null;
  fableIntent?: boolean | null;
  /** Route id or display name (`claude-1`); bypasses scoring but not eligibility. */
  requestedRoute?: string | null;
  /** Preview only: no reservation is recorded. */
  dryRun?: boolean;
}

export function resolveRouteRef(observation: Observation, ref: string): string | null {
  // `claude-<slot>` is the display name; it names the slot directly, so an
  // account cswap knows about resolves whether or not it is launch-eligible.
  const nameMatch = /^claude-([1-9]\d*)$/u.exec(ref);
  if (nameMatch !== null) {
    const id = routeIdForSlot(Number(nameMatch[1]));
    return id in observation.claude_accounts.ordinals ? id : null;
  }
  return /^claude-swap:[1-9]\d*$/u.test(ref) ? ref : null;
}

export function selectClaudeRoute(options: SelectClaudeOptions): ClaudeSelection {
  const nowMs = options.nowMs ?? Date.now();
  const observation = options.observation;
  const excluded: Record<string, LaunchRouteIssue[]> = {};

  if (observation.health !== "ok") {
    return {
      ok: false,
      refusal: "observation-unavailable",
      detail: `observation health is ${observation.health}`,
      excluded,
    };
  }
  const ageMs = nowMs - observation.observed_at_ms;
  if (ageMs > OBSERVATION_FRESHNESS_CEILING_MS) {
    return {
      ok: false,
      refusal: "observation-stale",
      detail: `observation is ${Math.round(ageMs / 1000)}s old (ceiling ${OBSERVATION_FRESHNESS_CEILING_MS / 1000}s)`,
      excluded,
    };
  }

  const intent = isFableRequest(options.model ?? null, options.fableIntent);
  const candidates: Route[] = [];
  for (const route of observation.routes) {
    const issues = routeIssues(route, options.model ?? null, options.fableIntent);
    if (issues.length === 0) candidates.push(route);
    else excluded[route.id] = issues;
  }

  const finish = (chosen: Route, reason: SelectionReason, ledger: Ledger, pool: readonly Route[]): ClaudeSelectionSuccess => {
    const scored: ScoredCandidate[] = pool.map((route) => {
      const entry = ledger.routes[route.id];
      return {
        id: route.id,
        slot: route.slot,
        score: routeScore(route, entry?.reservations.length ?? 0, options.model ?? null, options.fableIntent),
        pendingReservations: entry?.reservations.length ?? 0,
        lastSelectedAtMs:
          entry !== undefined && Number.isFinite(entry.last_selected_at) ? entry.last_selected_at : null,
      };
    });
    const reserve = options.dryRun !== true;
    if (reserve) {
      recordReservation(ledger, chosen.id, nowMs);
      writeSidecar(options.paths.reservations, serializeLedger(ledger));
    }
    return {
      ok: true,
      route: chosen,
      display_name: displayNameForRouteId(chosen.id),
      ordinal: observation.claude_accounts.ordinals[chosen.id] ?? null,
      reason,
      fableIntent: intent,
      observationAgeMs: ageMs,
      focus: { full: focusViews.fullState, fable: focusViews.fableState, nonFable: focusViews.nonFableState },
      pool: scored,
      excluded,
      reserved: reserve,
    };
  };

  const focusViews = readFocusViews(options.paths, observation, nowMs, intent);

  const locked = acquirePathLock(options.paths.reservationsLock, { staleMs: 5_000, waitMs: 2_000 });
  try {
    const ledger = pruneLedger(loadLedger(options.paths.reservations), nowMs);

    if (options.requestedRoute != null) {
      const resolved = resolveRouteRef(observation, options.requestedRoute);
      if (resolved === null) {
        return { ok: false, refusal: "requested-unknown", detail: `unknown route ref ${options.requestedRoute}`, excluded };
      }
      const route = candidates.find((candidate) => candidate.id === resolved);
      if (route === undefined) {
        const issues = excluded[resolved] ?? [];
        return {
          ok: false,
          refusal: "requested-ineligible",
          detail: `${resolved} is not launch-eligible${issues.length > 0 ? ` (${issues.join(", ")})` : ""}`,
          excluded,
        };
      }
      return finish(route, "requested-account", ledger, candidates);
    }

    if (candidates.length === 0) {
      const reasons = Object.entries(excluded).map(
        ([routeId, issues]) => `${displayNameForRouteId(routeId)}: ${issues.join(", ")}`,
      );
      const suffix = reasons.length === 0 ? "" : ` (${reasons.join("; ")})`;
      return {
        ok: false,
        refusal: "no-eligible-account",
        detail: `no launch-eligible Claude account${suffix}`,
        excluded,
      };
    }

    const findCandidate = (routeId: string | undefined): Route | undefined =>
      routeId === undefined ? undefined : candidates.find((candidate) => candidate.id === routeId);

    if (focusViews.fullPolicy !== null) {
      const fullTarget = findCandidate(focusViews.fullPolicy.target);
      if (fullTarget !== undefined) return finish(fullTarget, "full-focus", ledger, candidates);
      // An active provider focus suppresses the intent focuses even while its
      // target is ineligible — one policy is in charge at a time.
      const chosen = scoreAndPick(candidates, ledger, options.model ?? null, options.fableIntent);
      return finish(chosen, "full-focus-fallback", ledger, candidates);
    }

    if (intent) {
      const target = findCandidate(focusViews.fablePolicy?.target_route);
      if (focusViews.fablePolicy !== null && target !== undefined) {
        return finish(target, "fable-focus", ledger, candidates);
      }
      const chosen = scoreAndPick(candidates, ledger, options.model ?? null, options.fableIntent);
      if (focusViews.fablePolicy !== null) return finish(chosen, "fable-focus-fallback", ledger, candidates);
      return finish(chosen, candidates.length === 1 ? "sole-candidate" : "selected", ledger, candidates);
    }

    const nonFableTarget = findCandidate(focusViews.nonFablePolicy?.target_route);
    if (focusViews.nonFablePolicy !== null && nonFableTarget !== undefined) {
      return finish(nonFableTarget, "non-fable-focus", ledger, candidates);
    }
    let pool = candidates;
    let avoided = false;
    const fableTargetId = focusViews.fablePolicy?.target_route;
    if (fableTargetId !== undefined && candidates.length > 1) {
      const filtered = candidates.filter((route) => route.id !== fableTargetId);
      if (filtered.length !== candidates.length) {
        pool = filtered;
        avoided = true;
      }
    }
    const chosen = scoreAndPick(pool, ledger, options.model ?? null, options.fableIntent);
    if (focusViews.nonFablePolicy !== null) return finish(chosen, "non-fable-focus-fallback", ledger, pool);
    if (avoided) return finish(chosen, "fable-focus-avoided", ledger, pool);
    return finish(chosen, candidates.length === 1 ? "sole-candidate" : "selected", ledger, pool);
  } finally {
    if (locked) releasePathLock(options.paths.reservationsLock);
  }
}
