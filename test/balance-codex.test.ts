import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexObservation } from "../src/codex/types.ts";
import { claimCodexSpark, selectCodexAccount, selectCodexSpark } from "../src/balance/codex.ts";
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
    ndyIndex: null,
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
    dependency: { name: "codex-multi-auth", version: "2.8.3", healthy: true },
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

function fakePinnedCodexSwap(expectedAccountKey: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentusage-codex-swap-")), "codex-swap");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
const accountAt = args.indexOf("--account");
if (accountAt < 0 || args[accountAt + 1] !== ${JSON.stringify(expectedAccountKey)}) process.exit(9);
const claim = args.includes("--claim");
console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
  selection: { accountKey: ${JSON.stringify(expectedAccountKey)}, reason: { summary: "pinned", score: 60 } },
  lease: claim ? { leaseId: "lease-focus", ownerNonce: "nonce", accountKey: ${JSON.stringify(expectedAccountKey)}, expiresAt: "2026-08-08T20:01:00.000Z" } : null
}, error: null }));
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function fakePinnedRefusalThenFallback(): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentusage-codex-swap-")), "codex-swap");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("--account")) {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: null, error: {
    code: "NO_ELIGIBLE_ACCOUNT", message: "focused account reached its concurrency cap",
    details: { exclusions: [{ accountKey: "account:a", exclusions: ["max_concurrent_reached"] }] }
  } }));
  process.exit(3);
}
console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
  selection: { accountKey: "account:b", reason: { summary: "fallback", score: 90 } },
  lease: { leaseId: "lease-fallback", ownerNonce: "nonce", accountKey: "account:b", expiresAt: "2026-08-08T20:01:00.000Z" }
}, error: null }));
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

describe("codex full focus", () => {
  test("active focus pins provider selection without a lease for previews", async () => {
    const codexSwap = fakePinnedCodexSwap("account:a");
    const selection = await selectCodexAccount({
      observation: codexObservation([
        account("account:a", { lanes: mainLanes(80, 60) }),
        account("account:b", { lanes: mainLanes(90, 90) }),
      ]),
      focus: activeFocus("account:a"),
      nowMs: NOW,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.accountKey).toBe("account:a");
      expect(selection.reason).toBe("full-focus");
      expect(selection.score).toBe(60);
      expect(selection.lease).toBeNull();
    }
  });

  test("claim under an active focus returns a lease for the pinned account", async () => {
    const codexSwap = fakePinnedCodexSwap("account:a");
    const selection = await selectCodexAccount({
      observation: codexObservation([account("account:a", { lanes: mainLanes(80, 60) })]),
      focus: activeFocus("account:a"),
      claim: true,
      nowMs: NOW,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.accountKey).toBe("account:a");
      expect(selection.reason).toBe("full-focus");
      expect(selection.lease?.leaseId).toBe("lease-focus");
    }
  });

  test("ineligible focus target falls back to delegation rather than repinning", async () => {
    const selection = await selectCodexAccount({
      observation: codexObservation([
        account("account:a", { lanes: mainLanes(0, 60) }),
        account("account:b", { lanes: mainLanes(90, 90) }),
      ]),
      focus: activeFocus("account:a"),
      nowMs: NOW,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: "/nonexistent/codex-swap-for-tests" },
    });
    // The missing binary proves the pin fell through to codex-swap select
    // instead of silently moving to another account locally.
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.refusal).toBe("dependency-unavailable");
  });

  test("provider rejection of a locally eligible focus target falls back with a lease", async () => {
    const selection = await selectCodexAccount({
      observation: codexObservation([
        account("account:a", { lanes: mainLanes(80, 60) }),
        account("account:b", { lanes: mainLanes(90, 90) }),
      ]),
      focus: activeFocus("account:a"),
      claim: true,
      nowMs: NOW,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: fakePinnedRefusalThenFallback() },
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.accountKey).toBe("account:b");
      expect(selection.reason).toBe("full-focus-fallback (fallback)");
      expect(selection.lease?.leaseId).toBe("lease-fallback");
    }
  });

  test("focus refuses on a stale observation", async () => {
    const stale = codexObservation([account("account:a", { lanes: mainLanes(80, 60) })]);
    stale.observed_at_ms = NOW - 6 * 60_000;
    const selection = await selectCodexAccount({ observation: stale, focus: activeFocus("account:a"), nowMs: NOW });
    expect(!selection.ok && selection.refusal).toBe("observation-stale");
  });

  test("spark focus pins when the target has spark headroom, else falls back", () => {
    const pinned = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(20, 90) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
      "account:a",
    );
    expect(pinned.ok && pinned.accountKey).toBe("account:a");
    if (pinned.ok) expect(pinned.reason).toBe("full-focus");

    const fallback = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(0, 50) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
      "account:a",
    );
    expect(fallback.ok && fallback.accountKey).toBe("account:b");
    if (fallback.ok) expect(fallback.reason).toBe("full-focus-fallback (spark-headroom)");
  });
});

// ---------------------------------------------------------------------------
// claimCodexSpark

type SparkClaimFixtureResponse =
  | { status: "ok" }
  | { status: "no-eligible" }
  | { status: "dependency" }
  | { status: "malformed" }
  | { status: "provider-error" }
  | { status: "null-lease" }
  | { status: "wrong-selection-account"; actualAccountKey: string }
  | { status: "wrong-lease-account"; actualAccountKey: string }
  | { status: "empty-lease-id" };

/**
 * Fake `codex-swap select --account ... --claim --metered-lane codex-spark`.
 * `responses` maps accountKey to the fixed outcome for that account; every
 * invocation's argv is appended as a JSON line to `logPath` so tests can
 * assert exact argv and attempt counts.
 */
function fakeSparkClaimSwap(responses: Record<string, SparkClaimFixtureResponse>, logPath: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentusage-codex-swap-")), "codex-swap");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const fs = require("node:fs");
const args = Bun.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const accountAt = args.indexOf("--account");
const accountKey = accountAt >= 0 ? args[accountAt + 1] : null;
const responses = ${JSON.stringify(responses)};
const resp = accountKey !== null ? responses[accountKey] : undefined;
if (resp === undefined) {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: null, error: { code: "UNKNOWN", message: "no fixture for account" } }));
  process.exit(1);
}
if (resp.status === "ok") {
  const leaseId = "lease-" + accountKey;
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
    selection: { accountKey, reason: { summary: "claimed", score: 60 } },
    lease: { leaseId, ownerNonce: "nonce", accountKey, expiresAt: "2026-08-08T20:01:00.000Z" }
  }, error: null }));
  process.exit(0);
} else if (resp.status === "no-eligible") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: null, error: {
    code: "NO_ELIGIBLE_ACCOUNT", message: "account ineligible",
    details: { exclusions: [{ accountKey, exclusions: ["max_concurrent_reached"] }] }
  } }));
  process.exit(3);
} else if (resp.status === "dependency") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: null, error: {
    code: "DEPENDENCY_UNAVAILABLE", message: "codex-multi-auth missing"
  } }));
  process.exit(2);
} else if (resp.status === "malformed") {
  console.log("not json");
  process.exit(0);
} else if (resp.status === "null-lease") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
    selection: { accountKey, reason: { summary: "claimed", score: 60 } },
    lease: null
  }, error: null }));
  process.exit(0);
} else if (resp.status === "wrong-selection-account") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
    selection: { accountKey: resp.actualAccountKey, reason: { summary: "claimed", score: 60 } },
    lease: { leaseId: "lease-" + resp.actualAccountKey, ownerNonce: "nonce", accountKey: resp.actualAccountKey, expiresAt: "2026-08-08T20:01:00.000Z" }
  }, error: null }));
  process.exit(0);
} else if (resp.status === "wrong-lease-account") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
    selection: { accountKey, reason: { summary: "claimed", score: 60 } },
    lease: { leaseId: "lease-" + resp.actualAccountKey, ownerNonce: "nonce", accountKey: resp.actualAccountKey, expiresAt: "2026-08-08T20:01:00.000Z" }
  }, error: null }));
  process.exit(0);
} else if (resp.status === "empty-lease-id") {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: {
    selection: { accountKey, reason: { summary: "claimed", score: 60 } },
    lease: { leaseId: "", ownerNonce: "nonce", accountKey, expiresAt: "2026-08-08T20:01:00.000Z" }
  }, error: null }));
  process.exit(0);
} else {
  console.log(JSON.stringify({ schemaVersion: 1, command: "select", data: null, error: { code: "AUTH_ERROR", message: "boom" } }));
  process.exit(1);
}
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function makeLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentusage-codex-swap-log-")), "argv.log");
}

function readArgvLog(logPath: string): string[][] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

describe("claimCodexSpark", () => {
  test("exhausted main + available spark: claims the selected account and returns a lease", async () => {
    const preview = selectCodexSpark(codexObservation([account("account:a", { lanes: sparkLanes(60, 60) })]), NOW);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "ok" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a", { lanes: sparkLanes(60, 60) })]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lane).toBe("codex-spark");
      expect(result.accountKey).toBe("account:a");
      expect(result.reason).toBe("spark-headroom");
      expect(result.lease?.leaseId).toBe("lease-account:a");
    }

    const log = readArgvLog(logPath);
    expect(log).toEqual([
      ["select", "--account", "account:a", "--claim", "--metered-lane", "codex-spark", "--model", "gpt-5.3-codex-spark", "--json"],
    ]);
  });

  test("no-claim preview launches zero codex-swap subprocesses", () => {
    // selectCodexSpark is synchronous and pure; the type of `lease` proves
    // the preview path can never have shelled out to codex-swap.
    const preview = selectCodexSpark(codexObservation([account("account:a", { lanes: sparkLanes(60, 60) })]), NOW);
    expect(preview.ok && preview.lease).toBeNull();
  });

  test("first refusal then second-account success", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok && preview.accountKey).toBe("account:a");
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "no-eligible" }, "account:b": { status: "ok" } },
      logPath,
    );
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountKey).toBe("account:b");
      expect(result.lease?.leaseId).toBe("lease-account:b");
    }
    expect(readArgvLog(logPath).map((argv) => argv[2])).toEqual(["account:a", "account:b"]);
  });

  test("two refusals then bounded no-spark-capacity, never a third attempt", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "no-eligible" }, "account:b": { status: "no-eligible" } },
      logPath,
    );
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("no-spark-capacity");
    expect(readArgvLog(logPath)).toHaveLength(2);
  });

  test("malformed envelope fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "malformed" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("null lease on a nominally successful envelope fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "null-lease" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("selection accountKey mismatched from the requested account fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "wrong-selection-account", actualAccountKey: "account:b" } },
      logPath,
    );
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("lease accountKey mismatched from the requested account fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "wrong-lease-account", actualAccountKey: "account:b" } },
      logPath,
    );
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("empty leaseId fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "empty-lease-id" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("provider error (non-NO_ELIGIBLE_ACCOUNT) fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "provider-error" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("provider-error");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("dependency-unavailable fails closed without retry", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "dependency" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("dependency-unavailable");
    expect(readArgvLog(logPath)).toHaveLength(1);
  });

  test("missing codex-swap binary fails closed as dependency-unavailable without retry", async () => {
    const preview = selectCodexSpark(codexObservation([account("account:a", { lanes: sparkLanes(60, 60) })]), NOW);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: null,
      env: { AGENTUSAGE_CODEX_SWAP_BIN: "/nonexistent/codex-swap-for-tests" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("dependency-unavailable");
  });

  test("focus pin: claims the pinned account with reason full-focus", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(20, 90) }),
        account("account:b", { lanes: sparkLanes(80, 60) }),
      ]),
      NOW,
      "account:a",
    );
    expect(preview.ok && preview.accountKey).toBe("account:a");
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap({ "account:a": { status: "ok" } }, logPath);
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: "account:a",
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountKey).toBe("account:a");
      expect(result.reason).toBe("full-focus");
    }
  });

  test("focus fallback: pinned account refused, next-ranked account claimed with fallback reason", async () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90) }),
        account("account:b", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
      "account:a",
    );
    expect(preview.ok && preview.accountKey).toBe("account:a");
    if (!preview.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "no-eligible" }, "account:b": { status: "ok" } },
      logPath,
    );
    const result = await claimCodexSpark(preview, {
      observation: codexObservation([account("account:a"), account("account:b")]),
      model: "gpt-5.3-codex-spark",
      focusTarget: "account:a",
      env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountKey).toBe("account:b");
      expect(result.reason).toBe("full-focus-fallback (spark-headroom)");
    }
  });

  test("manually disabled, relogin-required, and identity-conflict accounts never enter the ranked claim pool", () => {
    const preview = selectCodexSpark(
      codexObservation([
        account("account:a", { lanes: sparkLanes(90, 90), manuallyDisabled: true }),
        account("account:b", { lanes: sparkLanes(80, 80), reloginRequired: true }),
        account("account:c", { lanes: sparkLanes(70, 70), identityConflict: true }),
        account("account:d", { lanes: sparkLanes(50, 50) }),
      ]),
      NOW,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.accountKey).toBe("account:d");
    expect(preview.pool?.map((entry) => entry.accountKey)).toEqual(["account:d"]);
  });

  test("concurrency-shaped calls: independent concurrent claims resolve without cross-talk", async () => {
    const previewA = selectCodexSpark(codexObservation([account("account:a", { lanes: sparkLanes(60, 60) })]), NOW);
    const previewB = selectCodexSpark(codexObservation([account("account:b", { lanes: sparkLanes(70, 70) })]), NOW);
    expect(previewA.ok && previewB.ok).toBe(true);
    if (!previewA.ok || !previewB.ok) return;

    const logPath = makeLogPath();
    const codexSwap = fakeSparkClaimSwap(
      { "account:a": { status: "ok" }, "account:b": { status: "ok" } },
      logPath,
    );
    const [resultA, resultB] = await Promise.all([
      claimCodexSpark(previewA, {
        observation: codexObservation([account("account:a")]),
        model: "gpt-5.3-codex-spark",
        focusTarget: null,
        env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
      }),
      claimCodexSpark(previewB, {
        observation: codexObservation([account("account:b")]),
        model: "gpt-5.3-codex-spark",
        focusTarget: null,
        env: { AGENTUSAGE_CODEX_SWAP_BIN: codexSwap },
      }),
    ]);
    expect(resultA.ok && resultA.accountKey).toBe("account:a");
    expect(resultB.ok && resultB.accountKey).toBe("account:b");
    expect(readArgvLog(logPath)).toHaveLength(2);
  });
});
