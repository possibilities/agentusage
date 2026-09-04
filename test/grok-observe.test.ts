import { describe, expect, test } from "bun:test";
import { buildGrokObservation } from "../src/grok/observe.ts";
import { validateGrokObservation } from "../src/grok/types.ts";
import { buildViewModel } from "../src/view.ts";

const NOW = Date.parse("2026-09-04T14:00:00Z");

function envelope(): unknown {
  return {
    schema_version: 1,
    ok: true,
    command: "observe",
    provider: "grok",
    data: {
      accounts: [
        {
          accountKey: "grok-account:one",
          displayName: "grok-1",
          ordinal: 1,
          alias: "work",
          email: "grok@example.com",
          enabled: true,
          authStatus: "valid",
          expiresAt: "2026-09-05T00:00:00Z",
          billingStatus: "fresh",
          included: {
            usedPercent: 28.5,
            remainingPercent: 71.5,
            periodType: "USAGE_PERIOD_TYPE_WEEKLY",
            periodStart: "2026-09-01T00:00:00Z",
            resetsAt: "2026-09-08T00:00:00Z",
          },
          prepaid: { balanceUsd: 12.34 },
          payg: { enabled: null, usedUsd: 1.25, capUsd: 10, remainingUsd: 8.75 },
          subscriptionTier: "SuperGrok",
          observedAt: "2026-09-04T13:59:00Z",
          lastGoodAt: "2026-09-04T13:59:00Z",
          stale: false,
          error: null,
        },
      ],
    },
  };
}

describe("buildGrokObservation", () => {
  test("normalizes account identity, allowance, and monetary billing facts", () => {
    const observation = buildGrokObservation(envelope(), NOW);
    expect(observation.health).toBe("ok");
    expect(validateGrokObservation(observation)).not.toBeNull();
    expect(observation.accounts).toHaveLength(1);
    const account = observation.accounts[0]!;
    expect(account.displayName).toBe("grok-1");
    expect(account.included?.periodType).toBe("weekly");
    expect(account.included?.usedPercent).toBe(28.5);
    expect(account.prepaid?.balanceUsd).toBe(12.34);
    expect(account.payg?.enabled).toBeNull();
    expect(account.payg?.remainingUsd).toBe(8.75);
    expect(account.observedAtMs).toBe(Date.parse("2026-09-04T13:59:00Z"));
  });

  test("builds one allowance meter and separate dollar facts", () => {
    const grok = buildGrokObservation(envelope(), NOW);
    grok.accounts[0]!.payg!.enabled = true;
    const off = { state: "off", policy: null, diagnostic: "none" } as never;
    const view = buildViewModel({
      claude: null,
      codex: null,
      grok,
      fable: off,
      nonFable: off,
      claudeFull: off,
      codexFull: off,
      grokFull: off,
      nowMs: NOW,
    });
    const card = view.grok?.cards[0]!;
    expect(card.meters).toHaveLength(1);
    expect(card.meters[0]).toMatchObject({ label: "weekly included", usedPercent: 28.5 });
    expect(card.facts).toEqual([
      { label: "prepaid", value: "$12.34 available", tone: "plain" },
      { label: "pay as you go", value: "$1.25 used · $8.75 left · $10.00 cap", tone: "plain" },
    ]);
  });

  test("keeps valid accounts while noting malformed rows", () => {
    const payload = envelope() as { data: { accounts: unknown[] } };
    payload.data.accounts.unshift({ ordinal: 2 });
    const observation = buildGrokObservation(payload, NOW);
    expect(observation.accounts).toHaveLength(1);
    expect(observation.notes).toEqual(["dropped a grok account row without a valid identity"]);
  });

  test("maps provider failures and schema drift to health", () => {
    expect(buildGrokObservation(null, NOW).health).toBe("malformed");
    expect(buildGrokObservation({ schema_version: 2 }, NOW).health).toBe("unsupported");
    expect(
      buildGrokObservation(
        {
          schema_version: 1,
          ok: false,
          provider: "grok",
          error: { code: "auth_unavailable", message: "sign in again" },
        },
        NOW,
      ).notes[0],
    ).toContain("auth_unavailable: sign in again");
  });

  test("requires positive immutable ordinals in sidecars", () => {
    const observation = buildGrokObservation(envelope(), NOW);
    observation.accounts[0]!.ordinal = 0;
    expect(validateGrokObservation(observation)).toBeNull();
  });
});
