import { describe, expect, test } from "bun:test";
import { buildCodexObservation, groupLanes } from "../src/codex/observe.ts";
import { laneHeadroomPercent, sparkLane, validateCodexObservation } from "../src/codex/types.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function sparkWindows(): unknown[] {
  return [
    { kind: "primary", label: "5h", windowSeconds: 18000, usedPercent: 30, remainingPercent: 70, resetsAt: "2026-08-08T22:00:00Z", resetAfterSeconds: 7200, limitName: null, meteredFeature: null },
    { kind: "secondary", label: "weekly", windowSeconds: 604800, usedPercent: 55, remainingPercent: 45, resetsAt: "2026-08-12T00:00:00Z", resetAfterSeconds: null, limitName: null, meteredFeature: null },
    { kind: "other", label: "5h", windowSeconds: 18000, usedPercent: 8, remainingPercent: 92, resetsAt: "2026-08-08T23:00:00Z", resetAfterSeconds: null, limitName: "GPT-5.3-Codex-Spark", meteredFeature: "gpt_5_3_codex_spark" },
    { kind: "other", label: "weekly", windowSeconds: 604800, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-08-13T00:00:00Z", resetAfterSeconds: null, limitName: "GPT-5.3-Codex-Spark", meteredFeature: "gpt_5_3_codex_spark" },
    { kind: "code_review", label: "weekly", windowSeconds: 604800, usedPercent: 2, remainingPercent: 98, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
    { kind: "other", label: "daily", windowSeconds: 86400, usedPercent: 1, remainingPercent: 99, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: null },
  ];
}

function snapshotEnvelope(): unknown {
  return {
    schemaVersion: 1,
    command: "snapshot",
    generatedAt: "2026-08-08T20:00:00Z",
    error: null,
    data: {
      schemaVersion: 1,
      dependency: { name: "codex-multi-auth", version: "2.8.3", healthy: true },
      canonicalCodexHome: "/tmp/x",
      recommendation: { accountKey: "account:abc" },
      accounts: [
        {
          accountKey: "account:abc",
          providerAccountId: "abc",
          email: "codex@example.com",
          label: "primary",
          enabled: true,
          present: true,
          ndyIndex: 1,
          auth: { status: "ok", reloginRequired: false },
          identityConflict: false,
          policy: { manuallyDisabled: false, priority: 0, weight: 1, maxConcurrent: null },
          usage: {
            status: "ok",
            decisionGrade: true,
            measurement: {
              schemaVersion: 1,
              probeKind: "direct-wham",
              planType: "plus",
              limitReached: false,
              resetCreditsAvailable: 1,
              windows: sparkWindows(),
              fetchedAt: "2026-08-08T19:59:00Z",
            },
            fetchedAt: "2026-08-08T19:59:00Z",
            ageSeconds: 60,
            nextPollAt: "2026-08-08T20:03:00Z",
            pollIntervalMs: 240000,
            lastError: null,
          },
          lastGoodUsage: null,
          selection: { eligible: true, exclusions: [], headroomPercent: 45, activeLeases: 2 },
        },
        {
          accountKey: "account:stale",
          email: "stale@example.com",
          label: null,
          enabled: true,
          present: true,
          ndyIndex: 2,
          auth: { status: "ok", reloginRequired: false },
          identityConflict: false,
          policy: { manuallyDisabled: false, priority: 0, weight: 1, maxConcurrent: null },
          usage: {
            status: "stale",
            decisionGrade: false,
            measurement: null,
            fetchedAt: null,
            ageSeconds: null,
            nextPollAt: null,
            pollIntervalMs: null,
            lastError: { code: "http_429", httpStatus: 429, summary: "rate limited", at: "2026-08-08T19:00:00Z" },
          },
          lastGoodUsage: {
            measurement: {
              schemaVersion: 1,
              probeKind: "direct-wham",
              resetCreditsAvailable: 3,
              windows: [
                { kind: "primary", label: "5h", windowSeconds: 18000, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-08-08T21:30:00Z", resetAfterSeconds: null, limitName: null, meteredFeature: null },
              ],
              fetchedAt: "2026-08-08T18:00:00Z",
            },
            fetchedAt: "2026-08-08T18:00:00Z",
            ageSeconds: 7200,
          },
          selection: { eligible: false, exclusions: ["quota_exhausted"], headroomPercent: 0, activeLeases: 0 },
        },
      ],
    },
  };
}

describe("groupLanes", () => {
  test("spark windows group into one non-binding lane by identity", () => {
    const lanes = groupLanes(sparkWindows());
    expect(lanes.map((lane) => lane.id)).toEqual(["main", "codex-spark", "code-review", "codex-extra"]);
    const main = lanes[0]!;
    expect(main.binding).toBe(true);
    expect(main.windows).toHaveLength(2);
    const spark = lanes[1]!;
    expect(spark.binding).toBe(false);
    expect(spark.title).toBe("GPT-5.3-Codex-Spark");
    expect(spark.windows).toHaveLength(2);
    expect(laneHeadroomPercent(spark)).toBe(0);
    expect(laneHeadroomPercent(main)).toBe(45);
  });
});

describe("buildCodexObservation", () => {
  test("maps accounts, lanes, recommendation, and last-good fallback", () => {
    const observation = buildCodexObservation(snapshotEnvelope(), NOW);
    expect(observation.health).toBe("ok");
    expect(validateCodexObservation(observation)).not.toBeNull();
    expect(observation.recommendation).toEqual({ accountKey: "account:abc" });
    expect(observation.dependency?.healthy).toBe(true);

    const primary = observation.accounts[0]!;
    expect(primary.measurementSource).toBe("current");
    expect(primary.planType).toBe("plus");
    expect(primary.resetCreditsAvailable).toBe(1);
    expect(primary.activeLeases).toBe(2);
    expect(sparkLane(primary)).not.toBeNull();
    expect(primary.measuredAtMs).toBe(Date.parse("2026-08-08T19:59:00Z"));

    const stale = observation.accounts[1]!;
    expect(stale.measurementSource).toBe("last-good");
    expect(stale.resetCreditsAvailable).toBe(3);
    expect(stale.usageStatus).toBe("stale");
    expect(stale.decisionGrade).toBe(false);
    expect(stale.exclusions).toEqual(["quota_exhausted"]);
    expect(stale.lanes[0]!.windows[0]!.usedPercent).toBe(100);
    expect(stale.lastError?.code).toBe("http_429");
  });

  test("error envelopes and unsupported schemas degrade to health", () => {
    expect(
      buildCodexObservation({ schemaVersion: 1, command: "snapshot", error: { code: "ndy_unsupported" }, data: null }, NOW)
        .health,
    ).toBe("error");
    expect(buildCodexObservation({ schemaVersion: 9, data: {} }, NOW).health).toBe("unsupported");
    expect(buildCodexObservation({ schemaVersion: 1, data: { schemaVersion: 2 } }, NOW).health).toBe("unsupported");
    expect(buildCodexObservation(null, NOW).health).toBe("malformed");
  });

  test("empty pool is healthy with zero accounts", () => {
    const envelope = snapshotEnvelope() as { data: { accounts: unknown[] } };
    envelope.data.accounts = [];
    const observation = buildCodexObservation(envelope, NOW);
    expect(observation.health).toBe("ok");
    expect(observation.accounts).toHaveLength(0);
  });

  test("rejects malformed reset-credit counts in sidecars", () => {
    const observation = buildCodexObservation(snapshotEnvelope(), NOW);
    observation.accounts[0]!.resetCreditsAvailable = -1;
    expect(validateCodexObservation(observation)).toBeNull();
  });
});
