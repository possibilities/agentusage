import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSERVATION_SCHEMA_VERSION, type NormalizedWindow, type Observation, type Route } from "../src/claude/types.ts";
import { statePaths } from "../src/paths.ts";
import { materializeFocusPolicy, materializeFullFocusPolicy, writeFocusLeaf } from "../src/focus.ts";
import { isFableRequest, resolveRouteRef, selectClaudeRoute } from "../src/balance/claude.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function route(slot: number, windows: Partial<Record<"session" | "week" | "fable", number>>): Route {
  const normalized: NormalizedWindow[] = [];
  if (windows.session !== undefined) normalized.push({ key: "session", utilization: windows.session, resetsAt: null });
  if (windows.week !== undefined) normalized.push({ key: "week", utilization: windows.week, resetsAt: null });
  if (windows.fable !== undefined) normalized.push({ key: "model:fable", utilization: windows.fable, resetsAt: null });
  return { id: `claude-swap:${slot}`, kind: "managed", slot, windows: normalized, measuredAtMs: NOW - 5_000 };
}

function observation(routes: Route[]): Observation {
  const ordinals: Record<string, number> = {};
  routes.forEach((entry, index) => {
    ordinals[entry.id] = index;
  });
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    routes,
    claude_accounts: { count: routes.length, ordinals },
    account_issues: {},
    notes: [],
  };
}

function freshPaths() {
  return statePaths({ AGENTUSAGE_STATE_ROOT: mkdtempSync(join(tmpdir(), "agentusage-balance-")) });
}

describe("isFableRequest", () => {
  test("recognizes only Fable model spellings", () => {
    for (const model of ["fable", "claude-fable-5"]) {
      expect(isFableRequest(model)).toBe(true);
    }
  });

  test("keeps ordinary and 1M-context models non-Fable and honors explicit intent", () => {
    for (const model of ["opus", "sonnet", "haiku", "opus-1m", "sonnet-1m", "opus[1m]", "claude-opus-4-6[1m]", null, undefined]) {
      expect(isFableRequest(model)).toBe(false);
    }
    expect(isFableRequest("opus", true)).toBe(true);
    expect(isFableRequest("fable", false)).toBe(false);
  });
});

describe("selectClaudeRoute", () => {
  test("fable request picks the lowest fable utilization", () => {
    const result = selectClaudeRoute({
      observation: observation([
        route(1, { session: 0.1, week: 0.1, fable: 0.7 }),
        route(2, { session: 0.9, week: 0.9, fable: 0.2 }),
      ]),
      paths: freshPaths(),
      nowMs: NOW,
      fableIntent: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.id).toBe("claude-swap:2");
      expect(result.reason).toBe("selected");
    }
  });

  test("non-fable prefers fable-less accounts, then most-burned fable", () => {
    const withFableless = selectClaudeRoute({
      observation: observation([
        route(1, { session: 0.8, week: 0.8 }),
        route(2, { session: 0.1, week: 0.1, fable: 0.1 }),
      ]),
      paths: freshPaths(),
      nowMs: NOW,
    });
    expect(withFableless.ok && withFableless.route.id).toBe("claude-swap:1");

    const amongFable = selectClaudeRoute({
      observation: observation([
        route(1, { session: 0.1, week: 0.1, fable: 0.2 }),
        route(2, { session: 0.3, week: 0.3, fable: 0.9 }),
      ]),
      paths: freshPaths(),
      nowMs: NOW,
    });
    expect(amongFable.ok && amongFable.route.id).toBe("claude-swap:2");
  });

  test("fable intent requires a fable window", () => {
    const result = selectClaudeRoute({
      observation: observation([route(1, { session: 0.1, week: 0.1 })]),
      paths: freshPaths(),
      nowMs: NOW,
      fableIntent: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("no-eligible-account");
      expect(result.detail).toBe(
        "no launch-eligible Claude account (claude-1: fable-entitlement-missing)",
      );
      expect(result.excluded["claude-swap:1"]).toEqual(["fable-entitlement-missing"]);
    }
  });

  test("a total refusal explains every excluded account", () => {
    const result = selectClaudeRoute({
      observation: observation([
        route(1, { session: 1, week: 0.2, fable: 0.5 }),
        route(2, { session: 0.2, week: 0.3, fable: 1 }),
      ]),
      paths: freshPaths(),
      nowMs: NOW,
      fableIntent: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe(
        "no launch-eligible Claude account (claude-1: session-quota-exhausted; claude-2: fable-quota-exhausted)",
      );
    }
  });

  test("exhausted windows exclude a route", () => {
    const result = selectClaudeRoute({
      observation: observation([
        route(1, { session: 1.0, week: 0.2 }),
        route(2, { session: 0.4, week: 0.4 }),
      ]),
      paths: freshPaths(),
      nowMs: NOW,
    });
    expect(result.ok && result.route.id).toBe("claude-swap:2");
    if (result.ok) expect(result.excluded["claude-swap:1"]).toEqual(["session-quota-exhausted"]);
  });

  test("reservations add pressure so concurrent launches spread", () => {
    const paths = freshPaths();
    const routes = () => [route(1, { session: 0.5, week: 0.2 }), route(2, { session: 0.5, week: 0.2 })];
    const first = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW });
    const second = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW + 1_000 });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.route.id).not.toBe(first.route.id);
  });

  test("dry runs never write reservations", () => {
    const paths = freshPaths();
    const routes = () => [route(1, { session: 0.5, week: 0.2 }), route(2, { session: 0.5, week: 0.2 })];
    const preview = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW, dryRun: true });
    const repeat = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW + 1_000, dryRun: true });
    expect(preview.ok && repeat.ok).toBe(true);
    if (preview.ok && repeat.ok) {
      expect(preview.reserved).toBe(false);
      expect(repeat.route.id).toBe(preview.route.id);
    }
  });

  test("active fable focus wins Fable launches and is avoided by non-Fable ones", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.fableFocusLeaf, materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, true, NOW));
    const routes = () => [
      route(1, { session: 0.9, week: 0.9, fable: 0.9 }),
      route(2, { session: 0.1, week: 0.1, fable: 0.1 }),
    ];
    const fable = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW, model: "fable" });
    expect(fable.ok && fable.route.id).toBe("claude-swap:1");
    if (fable.ok) expect(fable.reason).toBe("fable-focus");

    const generic = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW });
    expect(generic.ok && generic.route.id).toBe("claude-swap:2");
    if (generic.ok) expect(generic.reason).toBe("fable-focus-avoided");
  });

  test("1M-context and Haiku launches use binding windows but ignore exhausted Fable quota", () => {
    for (const model of ["opus-1m", "sonnet[1m]", "haiku"]) {
      const result = selectClaudeRoute({
        observation: observation([route(1, { session: 0.2, week: 0.3, fable: 1 })]),
        paths: freshPaths(),
        nowMs: NOW,
        model,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.fableIntent).toBe(false);
    }

    const exhaustedSession = selectClaudeRoute({
      observation: observation([route(1, { session: 1, week: 0.3, fable: 0.2 })]),
      paths: freshPaths(),
      nowMs: NOW,
      model: "haiku",
    });
    expect(exhaustedSession.ok).toBe(false);
    if (!exhaustedSession.ok) {
      expect(exhaustedSession.excluded["claude-swap:1"]).toEqual(["session-quota-exhausted"]);
    }
  });

  test("focus on an ineligible target falls back with the fallback reason", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.fableFocusLeaf, materializeFocusPolicy("claude-swap:9", { kind: "permanent" }, true, NOW));
    const result = selectClaudeRoute({
      observation: observation([route(1, { session: 0.2, week: 0.2, fable: 0.2 })]),
      paths,
      nowMs: NOW,
      fableIntent: true,
    });
    expect(result.ok && result.reason).toBe("fable-focus-fallback");
  });

  test("non-fable focus pins generic launches", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.nonFableFocusLeaf, materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, false, NOW));
    const result = selectClaudeRoute({
      observation: observation([
        route(1, { session: 0.9, week: 0.9 }),
        route(2, { session: 0.1, week: 0.1 }),
      ]),
      paths,
      nowMs: NOW,
    });
    expect(result.ok && result.route.id).toBe("claude-swap:1");
    if (result.ok) expect(result.reason).toBe("non-fable-focus");
  });

  test("full focus pins both intents and overrides the intent focuses", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.claudeFullFocusLeaf, materializeFullFocusPolicy("claude", "claude-swap:1", { kind: "permanent" }, NOW));
    writeFocusLeaf(paths.fableFocusLeaf, materializeFocusPolicy("claude-swap:2", { kind: "permanent" }, true, NOW));
    writeFocusLeaf(paths.nonFableFocusLeaf, materializeFocusPolicy("claude-swap:2", { kind: "permanent" }, false, NOW));
    const routes = () => [
      route(1, { session: 0.9, week: 0.9, fable: 0.9 }),
      route(2, { session: 0.1, week: 0.1, fable: 0.1 }),
    ];

    const fable = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW, fableIntent: true });
    expect(fable.ok && fable.route.id).toBe("claude-swap:1");
    if (fable.ok) {
      expect(fable.reason).toBe("full-focus");
      expect(fable.focus.full).toBe("active");
    }

    const generic = selectClaudeRoute({ observation: observation(routes()), paths, nowMs: NOW });
    expect(generic.ok && generic.route.id).toBe("claude-swap:1");
    if (generic.ok) expect(generic.reason).toBe("full-focus");
  });

  test("full-focus fallback ignores the intent focuses", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.claudeFullFocusLeaf, materializeFullFocusPolicy("claude", "claude-swap:9", { kind: "permanent" }, NOW));
    writeFocusLeaf(paths.nonFableFocusLeaf, materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, false, NOW));
    const result = selectClaudeRoute({
      observation: observation([
        route(1, { session: 0.9, week: 0.9 }),
        route(2, { session: 0.1, week: 0.1 }),
      ]),
      paths,
      nowMs: NOW,
    });
    // Scoring picks the lighter route; the non-fable focus on route 1 stays
    // suppressed while the full focus is active.
    expect(result.ok && result.route.id).toBe("claude-swap:2");
    if (result.ok) expect(result.reason).toBe("full-focus-fallback");
  });

  test("requested account beats an active full focus", () => {
    const paths = freshPaths();
    writeFocusLeaf(paths.claudeFullFocusLeaf, materializeFullFocusPolicy("claude", "claude-swap:1", { kind: "permanent" }, NOW));
    const result = selectClaudeRoute({
      observation: observation([route(1, { session: 0.2, week: 0.2 }), route(2, { session: 0.2, week: 0.2 })]),
      paths,
      nowMs: NOW,
      requestedRoute: "claude-2",
    });
    expect(result.ok && result.route.id).toBe("claude-swap:2");
    if (result.ok) expect(result.reason).toBe("requested-account");
  });

  test("requested routes bypass scoring but not eligibility", () => {
    const paths = freshPaths();
    const routes = [route(1, { session: 1.0, week: 0.2 }), route(2, { session: 0.2, week: 0.2 })];
    const eligible = selectClaudeRoute({
      observation: observation(routes),
      paths,
      nowMs: NOW,
      requestedRoute: "claude-2",
    });
    expect(eligible.ok && eligible.route.id).toBe("claude-swap:2");
    if (eligible.ok) expect(eligible.reason).toBe("requested-account");

    const refused = selectClaudeRoute({
      observation: observation(routes),
      paths,
      nowMs: NOW,
      requestedRoute: "claude-swap:1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe("requested-ineligible");
  });

  test("stale or unhealthy observations refuse", () => {
    const paths = freshPaths();
    const fresh = observation([route(1, { session: 0.1, week: 0.1 })]);
    const stale = { ...fresh, observed_at_ms: NOW - 6 * 60_000 };
    const staleResult = selectClaudeRoute({ observation: stale, paths, nowMs: NOW });
    expect(!staleResult.ok && staleResult.refusal).toBe("observation-stale");

    const errored = { ...fresh, health: "error" as const };
    const errorResult = selectClaudeRoute({ observation: errored, paths, nowMs: NOW });
    expect(!errorResult.ok && errorResult.refusal).toBe("observation-unavailable");
  });
});

describe("resolveRouteRef", () => {
  const observed = observation([route(1, { session: 0.1, week: 0.1 }), route(3, { session: 0.1, week: 0.1 })]);

  test("display names resolve by slot, not by position", () => {
    expect(resolveRouteRef(observed, "claude-1")).toBe("claude-swap:1");
    expect(resolveRouteRef(observed, "claude-3")).toBe("claude-swap:3");
    expect(resolveRouteRef(observed, "claude-2")).toBeNull();
  });

  test("route ids still resolve and the retired zero-based ref does not", () => {
    expect(resolveRouteRef(observed, "claude-swap:3")).toBe("claude-swap:3");
    expect(resolveRouteRef(observed, "c0")).toBeNull();
    expect(resolveRouteRef(observed, "claude-0")).toBeNull();
  });
});
