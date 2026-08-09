import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveClaudeFullFocus,
  effectiveCodexFullFocus,
  effectiveFableFocus,
  effectiveNonFableFocus,
  materializeFocusPolicy,
  materializeFullFocusPolicy,
  readFocusLeaf,
  readFullFocusLeaf,
  resolveObservedCodexWeeklyReset,
  resolveObservedFableReset,
  resolveObservedWeekReset,
  writeFocusLeaf,
} from "../src/focus.ts";
import { OBSERVATION_SCHEMA_VERSION, type Observation } from "../src/claude/types.ts";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexObservation } from "../src/codex/types.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function tempLeaf(): string {
  return join(mkdtempSync(join(tmpdir(), "agentusage-focus-")), "leaf.json");
}

function observationWithFable(resetAt: string, utilization: number): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    routes: [
      {
        id: "claude-swap:1",
        kind: "managed",
        slot: 1,
        measuredAtMs: NOW - 10_000,
        windows: [
          { key: "session", utilization: 0.2, resetsAt: null },
          { key: "week", utilization: 0.1, resetsAt: null },
          { key: "model:fable", utilization, resetsAt: resetAt },
        ],
      },
    ],
    claude_accounts: { count: 1, ordinals: { "claude-swap:1": 0 } },
    account_issues: {},
    notes: [],
  };
}

function observationWithWeek(resetAt: string, utilization: number): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    routes: [
      {
        id: "claude-swap:1",
        kind: "managed",
        slot: 1,
        measuredAtMs: NOW - 10_000,
        windows: [
          { key: "session", utilization: 0.2, resetsAt: null },
          { key: "week", utilization, resetsAt: resetAt },
          { key: "model:fable", utilization: 0.3, resetsAt: null },
        ],
      },
    ],
    claude_accounts: { count: 1, ordinals: { "claude-swap:1": 0 } },
    account_issues: {},
    notes: [],
  };
}

function codexObservationWithWeekly(resetAt: string | null, remainingPercent: number): CodexObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    dependency: null,
    recommendation: null,
    accounts: [
      {
        accountKey: "account:a",
        email: null,
        label: null,
        ndyIndex: null,
        enabled: true,
        present: true,
        authStatus: "ok",
        reloginRequired: false,
        identityConflict: false,
        manuallyDisabled: false,
        usageStatus: "ok",
        decisionGrade: true,
        planType: null,
        limitReached: false,
        measurementSource: "current",
        measuredAtMs: NOW - 10_000,
        lanes: [
          {
            id: "main",
            title: "Main",
            binding: true,
            windows: [
              { role: "primary", label: "5h", windowSeconds: 18000, usedPercent: 10, remainingPercent: 90, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
              { role: "secondary", label: "weekly", windowSeconds: 604800, usedPercent: 100 - remainingPercent, remainingPercent, resetsAt: resetAt, resetAfterSeconds: null, limitName: null, meteredFeature: null },
            ],
          },
        ],
        eligible: true,
        exclusions: [],
        headroomPercent: 50,
        activeLeases: 0,
        nextPollAt: null,
        lastError: null,
      },
    ],
    notes: [],
  };
}

describe("focus leaves", () => {
  test("round-trips a policy and a null clear", () => {
    const path = tempLeaf();
    const policy = materializeFocusPolicy("claude-swap:2", { kind: "permanent" }, true, NOW);
    writeFocusLeaf(path, policy);
    const delivered = readFocusLeaf(path, true);
    expect(delivered.available).toBe(true);
    expect(delivered.policy?.target_route).toBe("claude-swap:2");

    writeFocusLeaf(path, null);
    const cleared = readFocusLeaf(path, true);
    expect(cleared.available).toBe(true);
    expect(cleared.policy).toBeNull();
    expect(cleared.diagnostic).toBe("none");
  });

  test("missing leaf reads as off, not an error", () => {
    const delivery = readFocusLeaf(join(mkdtempSync(join(tmpdir(), "agentusage-focus-")), "absent.json"), true);
    expect(delivery.available).toBe(true);
    expect(delivery.policy).toBeNull();
    expect(delivery.diagnostic).toBe("delivery-missing");
  });

  test("group/other-readable leaves are refused as insecure", () => {
    const path = tempLeaf();
    writeFocusLeaf(path, materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, false, NOW));
    chmodSync(path, 0o644);
    const delivery = readFocusLeaf(path, false);
    expect(delivery.available).toBe(false);
    expect(delivery.diagnostic).toBe("delivery-insecure");
  });

  test("malformed and wrong-intent leaves are refused", () => {
    const path = tempLeaf();
    writeFileSync(path, "not json", { mode: 0o600 });
    expect(readFocusLeaf(path, true).diagnostic).toBe("delivery-malformed");

    const other = tempLeaf();
    writeFocusLeaf(other, materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, false, NOW));
    expect(readFocusLeaf(other, true).diagnostic).toBe("policy-invalid");
  });
});

describe("effective focus states", () => {
  test("permanent and absolute lifetimes", () => {
    const permanent = materializeFocusPolicy("claude-swap:1", { kind: "permanent" }, false, NOW);
    expect(effectiveNonFableFocus({ available: true, policy: permanent, diagnostic: "none" }, NOW).state).toBe("active");

    const future = materializeFocusPolicy(
      "claude-swap:1",
      { kind: "absolute", deadline_at: "2026-08-09T00:00:00Z" },
      false,
      NOW,
    );
    expect(effectiveNonFableFocus({ available: true, policy: future, diagnostic: "none" }, NOW).state).toBe("active");
    expect(
      effectiveNonFableFocus({ available: true, policy: future, diagnostic: "none" }, Date.parse("2026-08-09T00:00:00Z"))
        .state,
    ).toBe("expired");
  });

  test("cycle-end completes at the boundary or when the pinned window burns out", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    const policy = materializeFocusPolicy("claude-swap:1", { kind: "cycle-end", reset_at: reset }, true, NOW);
    const delivery = { available: true as const, policy, diagnostic: "none" as const };

    expect(effectiveFableFocus(delivery, observationWithFable(reset, 0.5), NOW).state).toBe("active");
    expect(effectiveFableFocus(delivery, observationWithFable(reset, 1.0), NOW).state).toBe("completed");
    expect(effectiveFableFocus(delivery, observationWithFable("2026-08-11T00:00:00.000Z", 1.0), NOW).state).toBe(
      "active",
    );
    expect(effectiveFableFocus(delivery, null, Date.parse(reset)).state).toBe("completed");
  });
});

describe("full focus leaves", () => {
  test("round-trips per provider and refuses the other provider's leaf", () => {
    const path = tempLeaf();
    writeFocusLeaf(path, materializeFullFocusPolicy("claude", "claude-swap:1", { kind: "permanent" }, NOW));
    const delivered = readFullFocusLeaf(path, "claude");
    expect(delivered.available).toBe(true);
    expect(delivered.policy?.target).toBe("claude-swap:1");
    expect(readFullFocusLeaf(path, "codex").diagnostic).toBe("policy-invalid");
  });

  test("claude targets must be route ids; codex targets are accountKeys", () => {
    const bad = tempLeaf();
    writeFocusLeaf(bad, materializeFullFocusPolicy("claude", "not-a-route", { kind: "permanent" }, NOW));
    expect(readFullFocusLeaf(bad, "claude").diagnostic).toBe("policy-invalid");

    const codex = tempLeaf();
    writeFocusLeaf(
      codex,
      materializeFullFocusPolicy("codex", "account:a", { kind: "cycle-end", reset_at: "2026-08-10T00:00:00.000Z" }, NOW),
    );
    expect(readFullFocusLeaf(codex, "codex").policy?.target).toBe("account:a");
  });
});

describe("effective full focus", () => {
  test("claude cycle-end completes at the boundary or when the week burns out", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    const policy = materializeFullFocusPolicy("claude", "claude-swap:1", { kind: "cycle-end", reset_at: reset }, NOW);
    const delivery = { available: true as const, policy, diagnostic: "none" as const };

    expect(effectiveClaudeFullFocus(delivery, observationWithWeek(reset, 0.5), NOW).state).toBe("active");
    expect(effectiveClaudeFullFocus(delivery, observationWithWeek(reset, 1.0), NOW).state).toBe("completed");
    expect(effectiveClaudeFullFocus(delivery, observationWithWeek("2026-08-11T00:00:00.000Z", 1.0), NOW).state).toBe(
      "active",
    );
    expect(effectiveClaudeFullFocus(delivery, null, Date.parse(reset)).state).toBe("completed");
  });

  test("codex cycle-end reads the main lane's weekly window", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    const policy = materializeFullFocusPolicy("codex", "account:a", { kind: "cycle-end", reset_at: reset }, NOW);
    const delivery = { available: true as const, policy, diagnostic: "none" as const };

    expect(effectiveCodexFullFocus(delivery, codexObservationWithWeekly(reset, 40), NOW).state).toBe("active");
    expect(effectiveCodexFullFocus(delivery, codexObservationWithWeekly(reset, 0), NOW).state).toBe("completed");
    expect(effectiveCodexFullFocus(delivery, null, Date.parse(reset)).state).toBe("completed");
  });
});

describe("observed weekly resets", () => {
  test("claude week reset resolves with the usual guards", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    const observation = observationWithWeek(reset, 0.4);
    expect(resolveObservedWeekReset(observation, "claude-swap:1", NOW, null)).toEqual({ ok: true, resetAt: reset });
    expect(resolveObservedWeekReset(observation, "claude-swap:9", NOW, null)).toEqual({
      ok: false,
      error: "target-unavailable",
    });
    expect(resolveObservedWeekReset(observation, "claude-swap:1", NOW, "2026-08-10T01:00:00Z")).toEqual({
      ok: false,
      error: "reset-mismatch",
    });
  });

  test("codex weekly reset comes from the main lane's secondary window", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    expect(resolveObservedCodexWeeklyReset(codexObservationWithWeekly(reset, 40), "account:a", NOW, null)).toEqual({
      ok: true,
      resetAt: reset,
    });
    expect(resolveObservedCodexWeeklyReset(codexObservationWithWeekly(null, 40), "account:a", NOW, null)).toEqual({
      ok: false,
      error: "reset-unavailable",
    });
    expect(resolveObservedCodexWeeklyReset(codexObservationWithWeekly(reset, 40), "account:zz", NOW, null)).toEqual({
      ok: false,
      error: "target-unavailable",
    });
  });
});

describe("resolveObservedFableReset", () => {
  test("resolves, guards, and refuses to advance cycles", () => {
    const reset = "2026-08-10T00:00:00.000Z";
    const observation = observationWithFable(reset, 0.4);
    expect(resolveObservedFableReset(observation, "claude-swap:1", NOW, null)).toEqual({ ok: true, resetAt: reset });
    expect(resolveObservedFableReset(observation, "claude-swap:9", NOW, null)).toEqual({
      ok: false,
      error: "target-unavailable",
    });
    expect(resolveObservedFableReset(observation, "claude-swap:1", NOW, "2026-08-10T01:00:00Z")).toEqual({
      ok: false,
      error: "reset-mismatch",
    });
    const nearReset = { ...observation, observed_at_ms: Date.parse(reset) - 1_000 };
    expect(resolveObservedFableReset(nearReset, "claude-swap:1", Date.parse(reset) + 1, null)).toEqual({
      ok: false,
      error: "reset-elapsed",
    });
    const stale = { ...observation, observed_at_ms: NOW - 10 * 60_000 };
    expect(resolveObservedFableReset(stale, "claude-swap:1", NOW, null)).toEqual({
      ok: false,
      error: "observation-stale",
    });
  });
});
