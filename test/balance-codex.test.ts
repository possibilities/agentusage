import { describe, expect, test } from "bun:test";
import { fixtureState, managed, seed } from './managed-fixtures.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { readLeases } from '../src/service/leases.ts';
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexObservation } from "../src/codex/types.ts";
import { chooseCodexWithLeases, selectCodexAccount, selectCodexSpark } from "../src/balance/codex.ts";
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
    ordinal: null,
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
    dependency: null,
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

describe("owned selection and reservations", () => {
  test("native workspace pins resolve before eligibility and shared-email ambiguity refuses", async () => {
    const state = fixtureState();
    const accounts = [managed('codex', 1, { email: 'shared@example.test', enabled: false }), managed('codex', 2, { email: 'shared@example.test' })];
    await seed(state, accounts);
    const observation = buildCodexObservation(accounts, Date.now());
    expect(observation.accounts[1]!.providerAccountId).toBe('identity-codex-2');
    const options = { env: state.env, observation };
    expect(await selectCodexAccount({ ...options, account: 'identity-codex-2' })).toMatchObject({ ok: true, accountKey: 'codex-2', lease: null });
    expect(await selectCodexAccount({ ...options, account: 'identity-codex-1' })).toMatchObject({ ok: false });
    expect(await selectCodexAccount({ ...options, account: 'shared@example.test' })).toMatchObject({ ok: false, detail: 'Account selector must resolve to exactly one account' });
    expect(readLeases(state.paths).leases).toHaveLength(0);
  });
  test("focus is gated, then falls back; explicit exhausted pins refuse", async () => {
    const state = fixtureState();
    const observation = codexObservation([account("codex-1", { lanes: mainLanes(60, 60) }), account("codex-2", { lanes: mainLanes(90, 90) })]);
    const options = { env: state.env, observation, nowMs: NOW, focus: activeFocus("codex-1") };
    expect(await selectCodexAccount(options)).toMatchObject({ ok: true, accountKey: "codex-1", reason: "full-focus", lease: null });
    observation.accounts[0]!.limitReached = true;
    expect(await selectCodexAccount(options)).toMatchObject({ ok: true, accountKey: "codex-2" });
    expect(await selectCodexAccount({ ...options, account: "codex-1" })).toMatchObject({ ok: false, refusal: "no-eligible-account" });
  });
  test("parallel claims atomically apply lease pressure and rotate; previews never claim", async () => {
    const state = fixtureState(); const accounts = [managed(), managed("codex", 2)]; await seed(state, accounts);
    const observation = buildCodexObservation(accounts, Date.now());
    const results = await Promise.all(Array.from({ length: 4 }, () => selectCodexAccount({ env: state.env, observation, claim: true })));
    expect(results.map(x => x.ok && x.accountKey).sort()).toEqual(["codex-1", "codex-1", "codex-2", "codex-2"]);
    expect(readLeases(state.paths).leases).toHaveLength(4);
    expect((await selectCodexAccount({ env: state.env, observation })).ok).toBe(true);
    expect(readLeases(state.paths).leases).toHaveLength(4);
  });
  test("disabled, stale, malformed and auth-broken pools refuse; unknown needs explicit allowance", async () => {
    const state = fixtureState();
    const observation = codexObservation([account("codex-1", { decisionGrade: false, lanes: mainLanes(70, 70) })]);
    expect((await selectCodexAccount({ env: state.env, observation, nowMs: NOW })).ok).toBe(false);
    expect((await selectCodexAccount({ env: state.env, observation, nowMs: NOW, allowUnknown: true })).ok).toBe(true);
    observation.accounts[0]!.reloginRequired = true;
    expect((await selectCodexAccount({ env: state.env, observation, nowMs: NOW, allowUnknown: true })).ok).toBe(false);
  });
  test("main quota cooldown does not disable Spark, and expires on schedule", () => {
    const observation = codexObservation([account("codex-1", { lanes: [...mainLanes(70, 70), sparkLanes(50, 50)[1]!], quotaBlockedUntilMs: { main: NOW + 60000 }, quotaBlockedAtMs: { main: NOW - 30_000 } })]);
    const leases = { schema_version: 1 as const, leases: [], last_selected: {} };
    expect(chooseCodexWithLeases(observation, "main", { nowMs: NOW }, leases, null).ok).toBe(false);
    expect(chooseCodexWithLeases(observation, "codex-spark", { nowMs: NOW }, leases, null).ok).toBe(true);
    expect(chooseCodexWithLeases(observation, "main", { nowMs: NOW + 60001 }, leases, null).ok).toBe(true);
  });
  test("a fresh positive measurement supersedes legacy or older cooldowns, not newer ones", () => {
    const leases = { schema_version: 1 as const, leases: [], last_selected: {} };
    const blocked = account("codex-1", {
      lanes: mainLanes(70, 70),
      quotaBlockedUntilMs: { main: NOW + 60_000 },
      quotaBlockedAtMs: { main: NOW - 120_000 },
    });
    expect(
      chooseCodexWithLeases(
        codexObservation([blocked]),
        "main",
        { nowMs: NOW },
        leases,
        null,
      ).ok,
    ).toBe(true);

    blocked.quotaBlockedAtMs = { main: NOW - 30_000 };
    expect(
      chooseCodexWithLeases(
        codexObservation([blocked]),
        "main",
        { nowMs: NOW },
        leases,
        null,
      ).ok,
    ).toBe(false);

    blocked.quotaBlockedAtMs = undefined;
    expect(
      chooseCodexWithLeases(
        codexObservation([blocked]),
        "main",
        { nowMs: NOW },
        leases,
        null,
      ).ok,
    ).toBe(true);
  });
});
