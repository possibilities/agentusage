import { describe, expect, test } from "bun:test";
import { OBSERVATION_SCHEMA_VERSION, type Observation } from "../src/claude/types.ts";
import type { CodexAccountView, CodexObservation } from "../src/codex/types.ts";
import { buildViewModel } from "../src/view.ts";

const NOW = Date.parse("2026-08-08T20:00:00Z");

const OFF = { state: "off", policy: null, raw: null } as never;

function claudeObservation(): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    // Slot 3 with no slot 2: display names follow the slot, so a gap in cswap's
    // numbering can never make a card name disagree with its route id.
    routes: [
      { id: "claude-swap:1", kind: "managed", slot: 1, windows: [], measuredAtMs: NOW - 5_000 },
      { id: "claude-swap:3", kind: "managed", slot: 3, windows: [], measuredAtMs: NOW - 5_000 },
    ],
    claude_accounts: { count: 2, ordinals: { "claude-swap:1": 0, "claude-swap:3": 1 } },
    account_issues: {},
    notes: [],
  };
}

function codexAccount(
  accountKey: string,
  ndyIndex: number | null,
  resetCreditsAvailable: number | null = null,
): CodexAccountView {
  return {
    accountKey,
    email: null,
    label: null,
    ndyIndex,
    enabled: true,
    present: true,
    authStatus: "ready",
    reloginRequired: false,
    identityConflict: false,
    manuallyDisabled: false,
    usageStatus: "ok",
    decisionGrade: true,
    planType: null,
    limitReached: false,
    resetCreditsAvailable,
    measurementSource: "current",
    measuredAtMs: NOW - 5_000,
    lanes: [],
    eligible: true,
    exclusions: [],
    headroomPercent: 100,
    activeLeases: 0,
    nextPollAt: null,
    lastError: null,
  };
}

function codexObservation(): CodexObservation {
  return {
    schema_version: 1,
    observed_at_ms: NOW - 10_000,
    health: "ok",
    dependency: null,
    recommendation: null,
    // codex-swap's ndyIndex is zero-based; display names add one.
    accounts: [codexAccount("account:a", 0), codexAccount("account:b", 1)],
    notes: [],
  };
}

function build(claude: Observation | null, codex: CodexObservation | null) {
  return buildViewModel({ claude, codex, grok: null, fable: OFF, nonFable: OFF, claudeFull: OFF, codexFull: OFF, grokFull: OFF, nowMs: NOW });
}

describe("account display names", () => {
  test("claude cards are named by slot, 1-indexed", () => {
    const model = build(claudeObservation(), null);
    expect(model.claude?.cards.map((card) => card.name)).toEqual(["claude-1", "claude-3"]);
  });

  test("codex cards are 1-indexed over the zero-based ndyIndex", () => {
    const model = build(null, codexObservation());
    expect(model.codex?.cards.map((card) => card.name)).toEqual(["codex-1", "codex-2"]);
  });

  test("codex cards exclude historical accounts absent from the provider store", () => {
    const observation = codexObservation();
    observation.accounts.push(
      { ...codexAccount("account:legacy-a", 0), present: false },
      { ...codexAccount("account:legacy-b", 1), present: false },
    );

    const model = build(null, observation);
    expect(model.codex?.cards.map((card) => card.name)).toEqual(["codex-1", "codex-2"]);
  });

  test("codex cards show only positive reset-credit availability", () => {
    const observation = codexObservation();
    observation.accounts = [codexAccount("account:a", 0, 1), codexAccount("account:b", 1, 0)];

    const model = build(null, observation);
    expect(model.codex?.cards[0]?.resetCreditsAvailable).toBe(1);
    expect(model.codex?.cards[0]?.detail).toBeNull();
    expect(model.codex?.cards[1]?.resetCreditsAvailable).toBe(0);
    expect(model.codex?.cards[1]?.detail).toBeNull();
  });
});
