import { describe, expect, test } from "bun:test";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexObservation } from "../src/codex/types.ts";
import { selectCodexAccount, selectCodexSpark } from "../src/balance/codex.ts";
import {
  materializeFullFocusPolicy,
  type FocusStatus,
  type FullFocusEffectiveState,
  type FullFocusPolicy,
} from "../src/focus.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function account(key: string, overrides: Partial<CodexAccountView> = {}): CodexAccountView {
  return {
    accountKey: key,
    email: `${key}@example.com`,
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
    planType: "plus",
    limitReached: false,
    measurementSource: "current",
    measuredAtMs: NOW - 60_000,
    lanes: [],
    eligible: true,
    exclusions: [],
    headroomPercent: 50,
    activeLeases: 0,
    nextPollAt: null,
    lastError: null,
    ...overrides,
  };
}

function sparkLanes(fiveHourRemaining: number, weeklyRemaining: number) {
  return [
    {
      id: "main",
      title: "Main",
      binding: true,
      windows: [
        { role: "primary" as const, label: "5h", windowSeconds: 18000, usedPercent: 100, remainingPercent: 0, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
      ],
    },
    {
      id: "codex-spark",
      title: "GPT-5.3-Codex-Spark",
      binding: false,
      windows: [
        { role: "other" as const, label: "5h", windowSeconds: 18000, usedPercent: 100 - fiveHourRemaining, remainingPercent: fiveHourRemaining, resetsAt: null, resetAfterSeconds: null, limitName: "GPT-5.3-Codex-Spark", meteredFeature: "gpt_5_3_codex_spark" },
        { role: "other" as const, label: "weekly", windowSeconds: 604800, usedPercent: 100 - weeklyRemaining, remainingPercent: weeklyRemaining, resetsAt: null, resetAfterSeconds: null, limitName: "GPT-5.3-Codex-Spark", meteredFeature: "gpt_5_3_codex_spark" },
      ],
    },
  ];
}

function codexObservation(accounts: CodexAccountView[]): CodexObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 30_000,
    health: "ok",
    dependency: { name: "codex-multi-auth", version: "2.8.3", healthy: true },
    recommendation: null,
    accounts,
    notes: [],
  };
}

describe("selectCodexSpark", () => {
  test("ranks by spark headroom even when main quota is exhausted", () => {
    const result = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(20, 90) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountKey).toBe("account:b");
      expect(result.score).toBe(60);
      expect(result.pool).toHaveLength(2);
    }
  });

  test("lane headroom is bounded by the tightest window", () => {
    const result = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 5) }),
        account("account:b", { lanes: sparkLanes(10, 80) }),
      ]),
      NOW,
    );
    expect(result.ok && result.accountKey).toBe("account:b");
  });

  test("spark-exhausted, auth-broken, and lane-less accounts are excluded", () => {
    const result = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(0, 50) }),
        account("account:b", { lanes: sparkLanes(70, 70), reloginRequired: true }),
        account("account:c", { lanes: [] }),
      ]),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("no-spark-capacity");
  });

  test("lease pressure breaks headroom ties", () => {
    const result = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(50, 50), activeLeases: 2 }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(result.ok && result.accountKey).toBe("account:b");
  });

  test("stale observations refuse", () => {
    const stale = codexObservation([account("account:a", { lanes: sparkLanes(50, 50) })]);
    stale.observed_at_ms = NOW - 6 * 60_000;
    const result = selectCodexSpark(stale, NOW);
    expect(!result.ok && result.refusal).toBe("observation-stale");
  });
});

function mainLanes(fiveHourRemaining: number, weeklyRemaining: number) {
  return [
    {
      id: "main",
      title: "Main",
      binding: true,
      windows: [
        { role: "primary" as const, label: "5h", windowSeconds: 18000, usedPercent: 100 - fiveHourRemaining, remainingPercent: fiveHourRemaining, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
        { role: "secondary" as const, label: "weekly", windowSeconds: 604800, usedPercent: 100 - weeklyRemaining, remainingPercent: weeklyRemaining, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
      ],
    },
  ];
}

function activeFocus(target: string): FocusStatus<FullFocusPolicy, FullFocusEffectiveState> {
  return {
    state: "active",
    policy: materializeFullFocusPolicy("codex", target, { kind: "permanent" }, NOW),
    diagnostic: "none",
  };
}

describe("codex full focus", () => {
  test("active focus pins the main lane locally without a lease", async () => {
    const selection = await selectCodexAccount({
      observation: codexObservation([
        account("account:a", { lanes: mainLanes(80, 60) }),
        account("account:b", { lanes: mainLanes(90, 90) }),
      ]),
      focus: activeFocus("account:a"),
      nowMs: NOW,
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.accountKey).toBe("account:a");
      expect(selection.reason).toBe("full-focus");
      expect(selection.score).toBe(60);
      expect(selection.lease).toBeNull();
    }
  });

  test("claim refuses under an active focus instead of unpinning", async () => {
    const selection = await selectCodexAccount({
      observation: codexObservation([account("account:a", { lanes: mainLanes(80, 60) })]),
      focus: activeFocus("account:a"),
      claim: true,
      nowMs: NOW,
    });
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.refusal).toBe("focus-claim-unsupported");
  });

  test("ineligible focus target falls back to delegation rather than repinning", async () => {
    const selection = await selectCodexAccount({
      observation: codexObservation([
        account("account:a", { lanes: mainLanes(0, 60) }),
        account("account:b", { lanes: mainLanes(90, 90) }),
      ]),
      focus: activeFocus("account:a"),
      nowMs: NOW,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: "/nonexistent/codex-swap-for-tests" },
    });
    // The missing binary proves the pin fell through to codex-swap select
    // instead of silently moving to another account locally.
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.refusal).toBe("dependency-unavailable");
  });

  test("focus refuses on a stale observation", async () => {
    const stale = codexObservation([account("account:a", { lanes: mainLanes(80, 60) })]);
    stale.observed_at_ms = NOW - 6 * 60_000;
    const selection = await selectCodexAccount({ observation: stale, focus: activeFocus("account:a"), nowMs: NOW });
    expect(!selection.ok && selection.refusal).toBe("observation-stale");
  });

  test("spark focus pins when the target has spark headroom, else falls back", () => {
    const pinned = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(20, 90) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
      "account:a",
    );
    expect(pinned.ok && pinned.accountKey).toBe("account:a");
    if (pinned.ok) expect(pinned.reason).toBe("full-focus");

    const fallback = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(0, 50) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
      "account:a",
    );
    expect(fallback.ok && fallback.accountKey).toBe("account:b");
    if (fallback.ok) expect(fallback.reason).toBe("full-focus-fallback (spark-headroom)");
  });
});
