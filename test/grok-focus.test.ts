import { describe, expect, test } from "bun:test";
import {
  effectiveGrokFullFocus,
  materializeFullFocusPolicy,
  resolveObservedGrokIncludedReset,
} from "../src/focus.ts";
import type { GrokObservation } from "../src/grok/types.ts";

const NOW = Date.parse("2026-09-04T14:00:00Z");
const RESET = "2026-09-08T00:00:00.000Z";

function observation(usedPercent: number, resetsAt: string | null = RESET): GrokObservation {
  return {
    schema_version: 1,
    observed_at_ms: NOW - 1_000,
    health: "ok",
    dependency: { name: "grok-swap", healthy: true },
    accounts: [
      {
        accountKey: "grok-account:one",
        displayName: "grok-1",
        ordinal: 1,
        alias: null,
        email: null,
        enabled: true,
        authStatus: "valid",
        expiresAt: null,
        billingStatus: "fresh",
        included: { usedPercent, remainingPercent: 100 - usedPercent, periodType: "weekly", periodStart: null, resetsAt },
        prepaid: null,
        payg: null,
        subscriptionTier: null,
        observedAtMs: NOW,
        lastGoodAtMs: NOW,
        stale: false,
        error: null,
      },
    ],
    notes: [],
  };
}

describe("Grok provider focus", () => {
  test("cycle-end completes on the matching included-allowance boundary", () => {
    const policy = materializeFullFocusPolicy("grok", "grok-account:one", { kind: "cycle-end", reset_at: RESET }, NOW);
    const delivery = { available: true as const, policy, diagnostic: "none" as const };
    expect(effectiveGrokFullFocus(delivery, observation(90), NOW).state).toBe("active");
    expect(effectiveGrokFullFocus(delivery, observation(100), NOW).state).toBe("completed");
    expect(effectiveGrokFullFocus(delivery, null, Date.parse(RESET)).state).toBe("completed");
  });

  test("current reset resolves by account key or immutable display name", () => {
    expect(resolveObservedGrokIncludedReset(observation(20), "grok-account:one", NOW, null)).toEqual({
      ok: true,
      resetAt: RESET,
    });
    expect(resolveObservedGrokIncludedReset(observation(20), "grok-1", NOW, RESET)).toEqual({
      ok: true,
      resetAt: RESET,
    });
    expect(resolveObservedGrokIncludedReset(observation(20, null), "grok-1", NOW, null)).toEqual({
      ok: false,
      error: "reset-unavailable",
    });
  });
});
