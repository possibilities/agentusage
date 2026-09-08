import { describe, expect, test } from "bun:test";
import { buildGrokObservation } from "../src/grok/observe.ts";
import { validateGrokObservation } from "../src/grok/types.ts";
import { buildViewModel } from "../src/view.ts";
import { account, billing } from "./grok-fixtures.ts";

const NOW = Date.parse("2026-09-04T14:00:00Z");
function stored() {
  const result = account(1, billing({
    included: { ...billing().included, usedPercent: 28.5, remainingPercent: 71.5 },
    prepaid: { balanceUsd: 12.34 },
    payg: { enabled: null, usedUsd: 1.25, capUsd: 10, remainingUsd: 8.75 },
  }), NOW - 60_000);
  result.alias = "work";
  return result;
}

describe("owned Grok observations", () => {
  test("normalizes allowance and dollar facts without credentials or a subprocess dependency", () => {
    const observation = buildGrokObservation([stored()], NOW);
    expect(observation.health).toBe("ok");
    expect(observation.dependency).toBeNull();
    expect(validateGrokObservation(observation)).not.toBeNull();
    expect(observation.accounts).toHaveLength(1);
    expect(observation.accounts[0]).toMatchObject({
      accountKey: "grok-1", displayName: "grok-1", alias: "work", observedAtMs: NOW - 60_000,
      included: { periodType: "weekly", usedPercent: 28.5 },
      prepaid: { balanceUsd: 12.34 }, payg: { enabled: null, remainingUsd: 8.75 },
    });
    const output = JSON.stringify(observation);
    expect(output).not.toContain("access-1");
    expect(output).not.toContain("refresh-1");
    expect(output).not.toContain("credentials");
  });

  test("builds one allowance meter and separate dollar facts", () => {
    const grok = buildGrokObservation([stored()], NOW);
    grok.accounts[0]!.payg!.enabled = true;
    const off = { state: "off", policy: null, diagnostic: "none" } as never;
    const view = buildViewModel({ claude: null, codex: null, grok, fable: off, nonFable: off,
      claudeFull: off, codexFull: off, grokFull: off, nowMs: NOW });
    const card = view.grok!.cards[0]!;
    expect(card.meters).toHaveLength(1);
    expect(card.meters[0]).toMatchObject({ label: "weekly included", usedPercent: 28.5 });
    expect(card.facts).toEqual([
      { label: "prepaid", value: "$12.34 available", tone: "plain" },
      { label: "pay as you go", value: "$1.25 used · $8.75 left · $10.00 cap", tone: "plain" },
    ]);
  });

  test("retains last-good display facts and sanitizes imported provider diagnostics", () => {
    const row = stored();
    row.observation.error = { code: "auth_unavailable", message: "reflected-refresh-secret" };
    const observation = buildGrokObservation([row], NOW);
    expect(observation.accounts[0]).toMatchObject({ authStatus: "error", billingStatus: "stale", stale: true });
    expect(JSON.stringify(observation)).not.toContain("reflected-refresh-secret");
    row.observation.error.code = "reflected-access-secret";
    expect(JSON.stringify(buildGrokObservation([row], NOW))).not.toContain("reflected-access-secret");
  });

  test("requires positive immutable ordinals in sidecars", () => {
    const observation = buildGrokObservation([stored()], NOW);
    observation.accounts[0]!.ordinal = 0;
    expect(validateGrokObservation(observation)).toBeNull();
  });
});
