import { describe, expect, test } from "bun:test";
import { buildCodexObservation, groupLanes } from "../src/codex/observe.ts";
import { laneHeadroomPercent, SPARK_LANE_ID, sparkLane, validateCodexObservation } from "../src/codex/types.ts";
import { selectCodexSpark } from "../src/balance/codex.ts";

import { managed } from "./managed-fixtures.ts";

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

  test("production-shaped limitName plus opaque meteredFeature classifies as spark", () => {
    const lanes = groupLanes([
      { kind: "other", label: "5h", windowSeconds: 18000, usedPercent: 8, remainingPercent: 92, resetsAt: null, resetAfterSeconds: null, limitName: "GPT-5.3-Codex-Spark", meteredFeature: "codex_bengalfox" },
    ]);
    expect(lanes.map((lane) => lane.id)).toEqual([SPARK_LANE_ID]);
  });

  test("missing limitName still classifies as spark via meteredFeature fallback", () => {
    const lanes = groupLanes([
      { kind: "other", label: "5h", windowSeconds: 18000, usedPercent: 8, remainingPercent: 92, resetsAt: null, resetAfterSeconds: null, limitName: null, meteredFeature: "some_spark_codename" },
    ]);
    expect(lanes.map((lane) => lane.id)).toEqual([SPARK_LANE_ID]);
  });

  test("unrelated labeled window is not classified as spark", () => {
    const lanes = groupLanes([
      { kind: "other", label: "weekly", windowSeconds: 604800, usedPercent: 10, remainingPercent: 90, resetsAt: null, resetAfterSeconds: null, limitName: "Code Review Extra", meteredFeature: "codex_otherfeature" },
    ]);
    expect(lanes.map((lane) => lane.id)).toEqual(["codex-code-review-extra"]);
  });
});

describe("owned Codex observations", () => {
  test("normalizes native usage, leases, stable identities and reset credits", () => {
    const a = managed();
    a.usage!.value.rate_limit_reset_credit_details = { available_count: 2, credits: [{ expires_at: "2026-10-08T12:00:00.000Z" }, { expires_at: null }] };
    const observation = buildCodexObservation([a], Date.now(), new Map([[a.key, 2]]));
    expect(validateCodexObservation(observation)).not.toBeNull();
    const view = observation.accounts[0]!;
    expect(view).toMatchObject({ accountKey: "codex-1", activeLeases: 2, decisionGrade: true, planType: "plus", resetCreditsAvailable: 2, resetCreditExpirations: ["2026-10-08T12:00:00.000Z", null] });
    expect(sparkLane(view)?.windows).toHaveLength(2);
    expect(selectCodexSpark(observation).ok).toBe(true);
  });
  test("reserve metadata is display-only and never restores main eligibility", () => {
    const a = managed();
    a.usage!.value.rate_limit = {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
    };
    a.usage!.value.additional_rate_limits = [{
      limit_name: "gpt-reserve",
      metered_feature: "gpt-reserve",
      normal_model_slug: "gpt-5.6-luna",
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
      },
    }];

    const view = buildCodexObservation([a], Date.now()).accounts[0]!;
    expect(view).toMatchObject({
      eligible: false,
      headroomPercent: 0,
      exclusions: ["quota_exhausted"],
    });
    expect(view.lanes.find((lane) => lane.id === "codex-gpt-reserve")).toMatchObject({
      binding: false,
      windows: [{ remainingPercent: 100 }, { remainingPercent: 100 }],
    });
    expect(JSON.stringify(view)).not.toContain("gpt-5.6-luna");
  });
  test("failed usage preserves last-good display and refuses both lanes", () => {
    const a = managed("codex", 1, { usage_error: { code: "http-429", status: 429 } });
    const observation = buildCodexObservation([a], Date.now());
    expect(observation.accounts[0]).toMatchObject({ measurementSource: "last-good", decisionGrade: false, usageStatus: "error" });
    expect(observation.accounts[0]!.lanes).toHaveLength(2);
    expect(selectCodexSpark(observation).ok).toBe(false);
  });
  test("malformed credit fields are rejected by sidecar validator", () => {
    const observation = buildCodexObservation([managed()], Date.now());
    observation.accounts[0]!.resetCreditsAvailable = -1;
    expect(validateCodexObservation(observation)).toBeNull();
    observation.accounts[0]!.resetCreditsAvailable = 1;
    observation.accounts[0]!.resetCreditExpirations = ["nope"];
    expect(validateCodexObservation(observation)).toBeNull();
  });
  test("weekly-only main limits accept a null or omitted secondary window", () => {
    for (const secondary of [null, undefined]) {
      const a = managed();
      a.usage!.value = {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 14, limit_window_seconds: 604800 },
          secondary_window: secondary,
        },
      };
      const observation = buildCodexObservation([a], Date.now());
      expect(validateCodexObservation(observation)).not.toBeNull();
      expect(observation.accounts[0]).toMatchObject({
        decisionGrade: true, eligible: true, headroomPercent: 86,
        lanes: [{ id: "main", windows: [{ role: "primary", label: "weekly" }] }],
      });
    }
  });
  test("a present malformed binding window never grants main capacity", () => {
    for (const role of ["primary_window", "secondary_window"]) {
      for (const window of [{}, [], "invalid", { used_percent: "14" }, { used_percent: -1 }, { used_percent: NaN }]) {
        const a = managed();
        (a.usage!.value.rate_limit as Record<string, unknown>)[role] = window;
        expect(buildCodexObservation([a], Date.now()).accounts[0]).toMatchObject({
          decisionGrade: false, eligible: false, headroomPercent: null,
        });
      }
    }
  });
  test("weekly-only limits still refuse exhausted capacity and explicit limit rejection", () => {
    for (const [used, limitReached] of [[100, false], [14, true]] as const) {
      const a = managed();
      a.usage!.value.rate_limit = {
        primary_window: { used_percent: used, limit_window_seconds: 604800 },
        secondary_window: null,
        limit_reached: limitReached,
      };
      expect(buildCodexObservation([a], Date.now()).accounts[0]).toMatchObject({
        decisionGrade: true, eligible: false, exclusions: ["quota_exhausted"],
      });
    }
  });
  test("missing required primary windows are not decision-grade; expired samples are stale", () => {
    const a = managed(); delete (a.usage!.value.rate_limit as Record<string, unknown>).primary_window;
    const b = managed("codex", 2); b.usage!.measured_at_ms -= 600_000;
    const observation = buildCodexObservation([a, b], Date.now());
    expect(observation.accounts.map(a => a.decisionGrade)).toEqual([false, false]);
    expect(observation.accounts[1]!.usageStatus).toBe("stale");
  });
});
