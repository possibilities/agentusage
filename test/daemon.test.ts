import { describe, expect, test } from "bun:test";
import { weeklyResetWakeDelayMs } from "../src/daemon.ts";
import { OBSERVATION_SCHEMA_VERSION, type Observation } from "../src/claude/types.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function observation(weekUtilization: number, resetsAt: string | null): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW,
    health: "ok",
    routes: [
      {
        id: "claude-swap:1",
        kind: "managed",
        slot: 1,
        measuredAtMs: NOW,
        windows: [
          { key: "session", utilization: 0.2, resetsAt: null },
          { key: "week", utilization: weekUtilization, resetsAt },
        ],
      },
    ],
    claude_accounts: { count: 1, ordinals: { "claude-swap:1": 0 } },
    account_issues: {},
    notes: [],
  };
}

describe("weeklyResetWakeDelayMs", () => {
  test("wakes 30s after an exhausted weekly window resets", () => {
    const reset = new Date(NOW + 90_000).toISOString();
    expect(weeklyResetWakeDelayMs(observation(1.0, reset), NOW)).toBe(120_000);
  });

  test("ignores unexhausted or reset-less windows", () => {
    expect(weeklyResetWakeDelayMs(observation(0.9, new Date(NOW + 90_000).toISOString()), NOW)).toBeNull();
    expect(weeklyResetWakeDelayMs(observation(1.0, null), NOW)).toBeNull();
  });

  test("considers issue accounts via display measurements", () => {
    const base = observation(0.1, null);
    const withIssue: Observation = {
      ...base,
      account_issues: { "claude-swap:2": "token-expired" },
      claude_accounts: { count: 2, ordinals: { "claude-swap:1": 0, "claude-swap:2": 1 } },
      account_measurements: {
        "claude-swap:2": {
          measuredAtMs: NOW,
          windows: [{ key: "week", utilization: 1.2, resetsAt: new Date(NOW + 60_000).toISOString() }],
        },
      },
    };
    expect(weeklyResetWakeDelayMs(withIssue, NOW)).toBe(90_000);
  });

  test("a just-elapsed reset still wakes within the slack window", () => {
    expect(weeklyResetWakeDelayMs(observation(1.0, new Date(NOW - 1000).toISOString()), NOW)).toBe(29_000);
  });

  test("resets elapsed past the slack never produce a wake", () => {
    expect(weeklyResetWakeDelayMs(observation(1.0, new Date(NOW - 60_000).toISOString()), NOW)).toBeNull();
  });
});
