import { describe, expect, test } from "bun:test";
import { normalizeBilling } from "../src/grok/billing.ts";
import { selectAccount } from "../src/grok/select.ts";
import { GrokError } from "../src/grok/model.ts";
import { account, billing, state } from "./grok-fixtures.ts";

describe("billing normalization", () => {
  test("normalizes modern cents, period, and PAYG fields", () => {
    expect(normalizeBilling({
      config: {
        creditUsagePercent: 37.5,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z" },
        prepaidBalance: { val: 1234 },
        onDemandUsed: { val: 250 },
        onDemandCap: { val: 1000 },
      },
      onDemandEnabled: true,
      subscriptionTier: "SuperGrok Heavy",
    })).toEqual({
      included: {
        usedPercent: 37.5,
        remainingPercent: 62.5,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodStart: "2026-09-01T00:00:00.000Z",
        resetsAt: "2026-09-08T00:00:00.000Z",
      },
      prepaid: { balanceUsd: 12.34 },
      payg: { enabled: true, usedUsd: 2.5, capUsd: 10, remainingUsd: 7.5 },
      subscriptionTier: "SuperGrok Heavy",
    });
  });

  test("supports tested legacy allowance fields and proto zero cents", () => {
    const result = normalizeBilling({
      config: {
        monthlyLimit: { val: 2000 }, used: { val: 500 }, prepaidBalance: {},
        billingPeriodStart: "2026-09-01T00:00:00Z", billingPeriodEnd: "2026-10-01T00:00:00Z",
      },
    });
    expect(result.included.usedPercent).toBe(25);
    expect(result.included.remainingPercent).toBe(75);
    expect(result.prepaid.balanceUsd).toBe(0);
    expect(result.included.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("treats a malformed cent object as unknown while preserving proto empty-object zero", () => {
    expect(normalizeBilling({ config: { creditUsagePercent: 10, prepaidBalance: {} } }).prepaid.balanceUsd).toBe(0);
    expect(normalizeBilling({ config: { creditUsagePercent: 10, prepaidBalance: { unexpected: true } } }).prepaid.balanceUsd).toBeNull();
  });

  test("legacy PAYG inference requires a positive cap", () => {
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandCap: {} } }).payg.enabled).toBeFalse();
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandUsed: { val: 1 } } }).payg.enabled).toBeNull();
    expect(normalizeBilling({ config: { creditUsagePercent: 100, onDemandCap: { val: 1 } } }).payg.enabled).toBeTrue();
  });
});

describe("selection", () => {
  test("prefers included allowance before prepaid and PAYG", () => {
    const now = Date.now();
    const included = account(1, billing({ included: { ...billing().included, remainingPercent: 1, usedPercent: 99 } }), now);
    const prepaid = account(2, billing({ included: { ...billing().included, remainingPercent: 0, usedPercent: 100 }, prepaid: { balanceUsd: 100 } }), now);
    const payg = account(3, billing({ included: { ...billing().included, remainingPercent: 0, usedPercent: 100 }, payg: { enabled: true, usedUsd: 1, capUsd: 100, remainingUsd: 99 } }), now);
    const result = selectAccount(state([payg, prepaid, included]), { mode: "best", account: null, allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
    expect(result.account.accountKey).toBe("grok-1");
    expect(result.score.tier).toBe("included");
    expect(result.reservation).toBeNull();
  });

  test("distinguishes incomplete capacity from known exhaustion", () => {
    const now = Date.now();
    const unknown = account(1, {
      included: { usedPercent: null, remainingPercent: null, periodType: null, periodStart: null, resetsAt: null },
      prepaid: { balanceUsd: null },
      payg: { enabled: null, usedUsd: null, capUsd: null, remainingUsd: null },
      subscriptionTier: null,
    }, now);
    expect(() => selectAccount(state([unknown]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now })).toThrow("incomplete included-capacity");
    expect(selectAccount(state([unknown]), { mode: "best", account: "grok-1", allowUnknown: true, dryRun: true, reserveSeconds: 30, now }).score.tier).toBe("unknown");

    const exhausted = account(2, billing({ included: { ...billing().included, usedPercent: 100, remainingPercent: 0 } }), now);
    try {
      selectAccount(state([exhausted]), { mode: "best", account: "grok-2", allowUnknown: true, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GrokError);
      expect((error as GrokError).code).toBe("account_exhausted");
    }
  });

  test("rotates next-available and creates short reservations", () => {
    const now = Date.now();
    const store = state([account(1, billing(), now), account(2, billing(), now)]);
    store.reservations.push({ id: "expired", accountKey: "grok-1", createdAtMs: now - 20_000, expiresAtMs: now - 10_000 });
    const first = selectAccount(store, { mode: "next-available", account: null, allowUnknown: false, dryRun: false, reserveSeconds: 10, now });
    const second = selectAccount(store, { mode: "next-available", account: null, allowUnknown: false, dryRun: false, reserveSeconds: 10, now: now + 1 });
    expect(first.account.accountKey).toBe("grok-1");
    expect(second.account.accountKey).toBe("grok-2");
    expect(first.reservation?.expiresAt).toBe(new Date(now + 10_000).toISOString());
    expect(store.reservations.some((reservation) => reservation.id === "expired")).toBeFalse();
  });

  test("last-good observations older than 24 hours are not decision-grade", () => {
    const now = Date.now();
    const old = account(1, billing(), now - 24 * 60 * 60_000 - 1);
    old.credentials.expiresAtMs = now + 60_000;
    try {
      selectAccount(state([old]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as GrokError).code).toBe("usage_unknown");
    }
  });

  test("uses explicit PAYG availability without prepaid data but rejects incomplete capped PAYG", () => {
    const now = Date.now();
    const payg = account(1, billing({
      included: { ...billing().included, usedPercent: 100, remainingPercent: 0 },
      prepaid: { balanceUsd: null },
      payg: { enabled: true, usedUsd: 1, capUsd: 10, remainingUsd: 9 },
    }), now);
    expect(selectAccount(state([payg]), { mode: "best", account: null, allowUnknown: false, dryRun: true, reserveSeconds: 30, now }).score.tier).toBe("payg");

    payg.observation.lastGood!.payg = { enabled: true, usedUsd: null, capUsd: 10, remainingUsd: null };
    try {
      selectAccount(state([payg]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as GrokError).code).toBe("usage_unknown");
    }
  });

  test("does not call known-disabled PAYG exhausted when prepaid capacity is unknown", () => {
    const now = Date.now();
    const incomplete = account(1, billing({
      included: { ...billing().included, usedPercent: 100, remainingPercent: 0 },
      prepaid: { balanceUsd: null },
      payg: { enabled: false, usedUsd: 0, capUsd: 0, remainingUsd: 0 },
    }), now);
    try {
      selectAccount(state([incomplete]), { mode: "best", account: "grok-1", allowUnknown: false, dryRun: true, reserveSeconds: 30, now });
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as GrokError).code).toBe("usage_unknown");
    }
  });
});

