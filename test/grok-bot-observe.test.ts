import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptFromStdout, observeGrokBot, usageFromHub } from "../src/grok-bot/observe.ts";
import { validateGrokBotObservation } from "../src/grok-bot/types.ts";
import { refreshGrokBotObservation } from "../src/observe.ts";
import { statePaths } from "../src/paths.ts";
import { buildViewModel } from "../src/view.ts";
import { linesToText, renderFrameLines } from "../src/render.ts";

const NOW = Date.parse("2026-09-22T16:00:00Z");
const START = Date.parse("2026-09-20T19:43:47.995Z");
const RESET = Date.parse("2026-09-27T19:43:47.995Z");

function hubUsage(extra: Record<string, unknown> = {}) {
  return {
    usagePercent: 17.691913,
    currentPeriodStartMs: START,
    nextResetAtMs: RESET,
    hasAvailableUsage: true,
    hasNonZeroIncludedLimit: true,
    includedLimitZero: false,
    trial: false,
    isTeamSeat: false,
    fundingPlan: "supergrok-plus",
    planLabel: "SuperGrok Plus",
    manageUrl: "https://cursor.com/dashboard/spending?for=grok%7Cuser_SECRET",
    onDemandEligible: true,
    onDemandEnabled: false,
    ...extra,
  };
}

function envelope(data: unknown) {
  return JSON.stringify({ schema_version: 1, ok: true, error: null, data: { usage: data } });
}

const off = { state: "off", policy: null, diagnostic: "none" } as never;

describe("Grok Bot usage", () => {
  test("keeps the weekly percent and drops the manage URL and account id", () => {
    const usage = usageFromHub(hubUsage());
    expect(usage).toMatchObject({
      usedPercent: 17.691913,
      periodStart: "2026-09-20T19:43:47.995Z",
      resetsAt: "2026-09-27T19:43:47.995Z",
      hasAvailableUsage: true,
      planLabel: "SuperGrok Plus",
      fundingPlan: "supergrok-plus",
      onDemandEligible: true,
      onDemandEnabled: false,
      trial: false,
      teamSeat: false,
    });
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("user_");
    expect(serialized).not.toContain("manageUrl");
  });

  test("refuses a payload that is only a URL", () => {
    expect(usageFromHub({ manageUrl: "https://example.test", usagePercent: "17" })).toBeNull();
    const refused = attemptFromStdout(JSON.stringify({
      schema_version: 1,
      ok: false,
      error: { code: "command_rejected", message: "https://secret.example/user_SECRET", detail: { reason: "not_yet_enabled" } },
      data: null,
    }));
    expect(refused.health).toBe("unsupported");
    expect(JSON.stringify(refused)).not.toContain("http");
    expect(JSON.stringify(refused)).not.toContain("user_");
    expect(refused.error?.message).toBe("Grok Bot usage is not enabled for this login");
  });

  test("renders a Grok Bot card beside owned Grok billing", () => {
    const observation = validateGrokBotObservation({
      schema_version: 1,
      observed_at_ms: NOW - 5_000,
      health: "ok",
      stale: false,
      error: null,
      notes: [],
      usage: usageFromHub(hubUsage()),
    });
    expect(observation).not.toBeNull();
    const view = buildViewModel({
      claude: null,
      codex: null,
      grok: null,
      grokBot: observation,
      fable: off,
      nonFable: off,
      claudeFull: off,
      codexFull: off,
      grokFull: off,
      nowMs: NOW,
    });
    const card = view.grokBot!.cards[0]!;
    expect(card.name).toBe("grok-bot-1");
    expect(card.detail).toBe("SuperGrok Plus");
    expect(card.meters[0]).toMatchObject({ label: "weekly included", usedPercent: 17.691913 });
    expect(card.facts).toEqual([{ label: "on demand", value: "off", tone: "plain" }]);
    const text = linesToText(renderFrameLines(view, 80, { title: false }), false);
    expect(text).toContain("grok-bot-1");
    expect(text).toContain("weekly included");
    expect(text).not.toContain("http");
  });

  test("keeps the last good percent when the next read fails", async () => {
    const first = await observeGrokBot({
      nowMs: NOW,
      run: async () => ({ ok: true, code: 0, stdout: envelope(hubUsage()), stderr: "", error: null, enoent: false }),
    });
    const second = await observeGrokBot({
      nowMs: NOW + 1_000,
      previous: first,
      run: async () => ({ ok: false, code: null, stdout: "", stderr: "token=secret", error: "timeout", enoent: false }),
    });
    expect(second.health).toBe("stale");
    expect(second.stale).toBe(true);
    expect(second.usage?.usedPercent).toBe(17.691913);
    expect(JSON.stringify(second)).not.toContain("secret");
    expect(second.error?.message).toBe("Grok Bot usage timed out");
  });

  test("publishes a sidecar from a fake agentgrok and never the hub URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-bot-"));
    const bin = join(root, "agentgrok");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${envelope(hubUsage()).replaceAll("'", "'\\''")}'\n`);
    chmodSync(bin, 0o755);
    const paths = statePaths({ AGENTUSAGE_STATE_ROOT: root });
    const result = await refreshGrokBotObservation(paths, {
      freshWithinMs: 0,
      env: { ...process.env, AGENTUSAGE_STATE_ROOT: root, AGENTUSAGE_GROK_BOT_BIN: bin },
    });
    expect(result.outcome).toBe("refreshed");
    expect(result.value?.usage?.planLabel).toBe("SuperGrok Plus");
    expect(validateGrokBotObservation(result.value)).not.toBeNull();
    const saved = JSON.stringify(result.value);
    expect(saved).not.toContain("manageUrl");
    expect(saved).not.toContain("user_");
  });
});
