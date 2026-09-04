import { describe, expect, test } from "bun:test";
import { AUTH_FAILURE_GRACE_MS } from "../src/constants.ts";
import {
  OBSERVATION_SCHEMA_VERSION,
  type AccountObservationIssue,
  type NormalizedWindow,
  type Observation,
} from "../src/claude/types.ts";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexObservation } from "../src/codex/types.ts";
import { linesToText, renderFrameLines } from "../src/render.ts";
import { buildViewModel } from "../src/view.ts";

const NOW = Date.parse("2026-09-04T13:00:00Z");
const OFF = { state: "off", policy: null, raw: null } as never;
const WINDOWS: NormalizedWindow[] = [{ key: "session", utilization: 0.2, resetsAt: null }];

function build(input: { claude?: Observation | null; codex?: CodexObservation | null }) {
  return buildViewModel({
    claude: input.claude ?? null,
    codex: input.codex ?? null,
    fable: OFF,
    nonFable: OFF,
    claudeFull: OFF,
    codexFull: OFF,
    nowMs: NOW,
  });
}

// ---------------------------------------------------------------------------
// Codex

function codexAccount(overrides: Partial<CodexAccountView> = {}): CodexAccountView {
  return {
    accountKey: "record:abc",
    email: "operator@example.com",
    label: "Personal",
    ndyIndex: 1,
    enabled: true,
    present: true,
    authStatus: "ready",
    reloginRequired: false,
    identityConflict: false,
    manuallyDisabled: false,
    usageStatus: "ok",
    decisionGrade: true,
    planType: "pro",
    limitReached: false,
    resetCreditsAvailable: null,
    measurementSource: "current",
    measuredAtMs: NOW - 15_000,
    lanes: [],
    eligible: true,
    exclusions: [],
    headroomPercent: 60,
    activeLeases: 0,
    nextPollAt: null,
    lastError: null,
    ...overrides,
  };
}

function codexObservation(account: CodexAccountView): CodexObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 5_000,
    health: "ok",
    dependency: null,
    recommendation: null,
    accounts: [account],
    notes: [],
  };
}

describe("codex remediation", () => {
  test("infers a dead credential codex-swap has not flagged itself", () => {
    // The shape that hid in plain sight: auth still "ready", reloginRequired
    // false, but the usage endpoint 401s and last-good numbers keep serving.
    const vm = build({
      codex: codexObservation(
        codexAccount({
          usageStatus: "backoff",
          measurementSource: "last-good",
          measuredAtMs: NOW - 33 * 3_600_000,
          decisionGrade: false,
          lastError: { code: "auth", httpStatus: 401, summary: "usage endpoint rejected authentication (401)" },
        }),
      ),
    });
    expect(vm.remediations).toHaveLength(1);
    expect(vm.remediations[0]).toMatchObject({
      account: "codex-2",
      provider: "codex",
      command: "codex-swap auth add",
      hint: "sign in as operator@example.com",
    });
    expect(vm.remediations[0]?.reason).toBe("credential rejected 1d 9h");
  });

  test("stays quiet while an auth blip is inside the grace window", () => {
    const vm = build({
      codex: codexObservation(
        codexAccount({
          usageStatus: "backoff",
          measurementSource: "last-good",
          measuredAtMs: NOW - (AUTH_FAILURE_GRACE_MS - 60_000),
          lastError: { code: "auth", httpStatus: 401, summary: null },
        }),
      ),
    });
    expect(vm.remediations).toHaveLength(0);
  });

  test("stays quiet when a 401 already recovered into a current measurement", () => {
    const vm = build({
      codex: codexObservation(
        codexAccount({
          measurementSource: "current",
          measuredAtMs: NOW - 15_000,
          lastError: { code: "auth", httpStatus: 401, summary: null },
        }),
      ),
    });
    expect(vm.remediations).toHaveLength(0);
  });

  test("ignores non-auth poll errors however old the sample is", () => {
    const vm = build({
      codex: codexObservation(
        codexAccount({
          usageStatus: "error",
          measurementSource: "last-good",
          measuredAtMs: NOW - 48 * 3_600_000,
          lastError: { code: "network", httpStatus: 503, summary: null },
        }),
      ),
    });
    expect(vm.remediations).toHaveLength(0);
  });

  test("takes codex-swap's own relogin flag without waiting for the grace", () => {
    const vm = build({ codex: codexObservation(codexAccount({ reloginRequired: true })) });
    expect(vm.remediations[0]?.reason).toBe("re-login required");
  });

  test("replaces the status word rather than doubling it", () => {
    const vm = build({
      codex: codexObservation(
        codexAccount({
          usageStatus: "backoff",
          measurementSource: "last-good",
          measuredAtMs: NOW - 33 * 3_600_000,
          lastError: { code: "auth", httpStatus: 401, summary: null },
        }),
      ),
    });
    expect(vm.codex?.cards[0]?.status).toBeNull();
    expect(vm.codex?.cards[0]?.remediation).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claude

function claudeObservation(issue: AccountObservationIssue): Observation {
  const id = "claude-swap:2";
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW - 5_000,
    health: "ok",
    routes: [],
    claude_accounts: { count: 1, ordinals: { [id]: 0 } },
    account_issues: { [id]: issue },
    account_measurements: { [id]: { windows: WINDOWS, measuredAtMs: NOW - 30_000 } },
    notes: [],
  };
}

describe("claude remediation", () => {
  test("maps credential issues to a recover command", () => {
    for (const issue of ["relogin-required", "token-expired", "no-credentials", "keychain-unavailable"] as const) {
      const vm = build({ claude: claudeObservation(issue) });
      expect(vm.remediations).toHaveLength(1);
      expect(vm.remediations[0]?.command).toBe("agentusage recover claude-2");
    }
  });

  test("leaves issues no re-login can fix as a status word", () => {
    for (const issue of ["api-key", "usage-unavailable", "account-unavailable", "missing-windows"] as const) {
      const vm = build({ claude: claudeObservation(issue) });
      expect(vm.remediations).toHaveLength(0);
      expect(vm.claude?.cards[0]?.status).toBe(issue);
    }
  });
});

// ---------------------------------------------------------------------------
// Frame

describe("action required banner", () => {
  test("announces the account and command above the sections", () => {
    const vm = build({
      codex: codexObservation(
        codexAccount({
          usageStatus: "backoff",
          measurementSource: "last-good",
          measuredAtMs: NOW - 33 * 3_600_000,
          lastError: { code: "auth", httpStatus: 401, summary: null },
        }),
      ),
    });
    const text = linesToText(renderFrameLines(vm, 100, { title: false }), false);
    expect(text).toContain("▎ ACTION REQUIRED");
    expect(text).toContain("⚠ codex-2 · credential rejected 1d 9h");
    expect(text).toContain("codex-swap auth add  (sign in as operator@example.com)");
    expect(text.indexOf("ACTION REQUIRED")).toBeLessThan(text.indexOf("Pro · Personal"));
  });

  test("adds nothing to a healthy frame", () => {
    const vm = build({ codex: codexObservation(codexAccount()) });
    expect(vm.remediations).toHaveLength(0);
    expect(linesToText(renderFrameLines(vm, 100, { title: false }), false)).not.toContain("ACTION REQUIRED");
  });
});
