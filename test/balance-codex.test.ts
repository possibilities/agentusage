import { describe, expect, test } from "bun:test";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexObservation } from "../src/codex/types.ts";
import { selectCodexSpark } from "../src/balance/codex.ts";

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
