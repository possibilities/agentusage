import { describe, expect, test } from "bun:test";
import { buildObservation } from "../src/claude/observe.ts";
import { validateObservation } from "../src/claude/types.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

function cswapPayload(): unknown {
  return {
    schemaVersion: 1,
    activeAccountNumber: 1,
    accounts: [
      {
        number: 1,
        email: "a@example.com",
        usageStatus: "ok",
        usageFetchedAt: "2026-08-08T19:59:20Z",
        subscriptionType: "max",
        rateLimitMultiplier: 20,
        usage: {
          fiveHour: { pct: 33.2, resetsAt: "2026-08-08T23:20:00Z" },
          sevenDay: { pct: 12, resetsAt: "2026-08-12T02:00:00Z" },
          spend: { pct: 4 },
          scoped: [{ name: "Fable", pct: 58, resetsAt: "2026-08-10T00:00:00Z" }],
        },
      },
      {
        number: 2,
        email: "b@example.com",
        usageStatus: "token_expired",
        lastGoodUsage: {
          fiveHour: { pct: 90, resetsAt: "2026-08-08T21:00:00Z" },
          sevenDay: { pct: 70 },
        },
        lastGoodAgeSeconds: 600,
      },
      {
        number: 3,
        email: "c@example.com",
        usageStatus: "ok",
        usageAgeSeconds: 30,
        usage: { fiveHour: { pct: 10 } },
      },
    ],
  };
}

describe("buildObservation", () => {
  test("routes, issues, ordinals, capacity, and measurements", () => {
    const observation = buildObservation(cswapPayload(), NOW);
    expect(observation.health).toBe("ok");
    expect(validateObservation(observation)).not.toBeNull();

    expect(observation.routes).toHaveLength(1);
    const route = observation.routes[0]!;
    expect(route.id).toBe("claude-swap:1");
    expect(route.slot).toBe(1);
    expect(route.measuredAtMs).toBe(Date.parse("2026-08-08T19:59:20Z"));
    const keys = route.windows.map((window) => window.key).sort();
    expect(keys).toEqual(["model:fable", "session", "spend", "week"]);
    const fable = route.windows.find((window) => window.key === "model:fable")!;
    expect(fable.utilization).toBeCloseTo(0.58);

    expect(observation.account_issues["claude-swap:2"]).toBe("token-expired");
    expect(observation.account_issues["claude-swap:3"]).toBe("missing-windows");
    expect(observation.claude_accounts.count).toBe(3);
    expect(observation.claude_accounts.ordinals).toEqual({
      "claude-swap:1": 0,
      "claude-swap:2": 1,
      "claude-swap:3": 2,
    });
    expect(observation.account_capacity?.["claude-swap:1"]).toEqual({
      subscriptionType: "max",
      rateLimitMultiplier: 20,
    });

    const lastGood = observation.account_measurements?.["claude-swap:2"];
    expect(lastGood).toBeDefined();
    expect(lastGood!.measuredAtMs).toBe(NOW - 600_000);
    expect(lastGood!.windows.map((window) => window.key).sort()).toEqual(["session", "week"]);

    const partial = observation.account_measurements?.["claude-swap:3"];
    expect(partial).toBeDefined();
    expect(partial!.measuredAtMs).toBe(NOW - 30_000);
  });

  test("malformed scoped windows poison the whole account", () => {
    const payload = cswapPayload() as { accounts: Record<string, unknown>[] };
    (payload.accounts[0]!.usage as Record<string, unknown>).scoped = [
      { name: "Fable", pct: 10 },
      { name: "fable", pct: 20 },
    ];
    const observation = buildObservation(payload, NOW);
    expect(observation.routes).toHaveLength(0);
    expect(observation.account_issues["claude-swap:1"]).toBe("malformed-scoped-windows");
    expect(validateObservation(observation)).not.toBeNull();
  });

  test("naive timestamps fall back to age seconds, else missing-freshness", () => {
    const payload = cswapPayload() as { accounts: Record<string, unknown>[] };
    payload.accounts[0]!.usageFetchedAt = "2026-08-08 12:00:00";
    delete payload.accounts[0]!.usageAgeSeconds;
    const observation = buildObservation(payload, NOW);
    expect(observation.account_issues["claude-swap:1"]).toBe("missing-freshness");
  });

  test("unsupported schema and malformed payloads", () => {
    expect(buildObservation({ schemaVersion: 2, accounts: [] }, NOW).health).toBe("unsupported");
    expect(buildObservation("nope", NOW).health).toBe("malformed");
    expect(buildObservation({ schemaVersion: 1, accounts: "x" }, NOW).health).toBe("malformed");
  });

  test("over-limit percentages exceed 1.0 utilization and stay routes", () => {
    const payload = cswapPayload() as { accounts: Record<string, unknown>[] };
    ((payload.accounts[0]!.usage as Record<string, unknown>).fiveHour as Record<string, unknown>).pct = 104;
    const observation = buildObservation(payload, NOW);
    const route = observation.routes[0]!;
    const session = route.windows.find((window) => window.key === "session")!;
    expect(session.utilization).toBeCloseTo(1.04);
  });
});
