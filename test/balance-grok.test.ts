import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { selectGrokAccount } from "../src/balance/grok.ts";
import { materializeFullFocusPolicy, type FocusStatus, type FullFocusEffectiveState, type FullFocusPolicy } from "../src/focus.ts";
import type { GrokAccountView, GrokObservation } from "../src/grok/types.ts";

const NOW = Date.parse("2026-09-04T14:00:00Z");

function account(overrides: Partial<GrokAccountView> = {}): GrokAccountView {
  return {
    accountKey: "grok-account:one",
    displayName: "grok-1",
    ordinal: 1,
    alias: "work",
    email: "grok@example.com",
    enabled: true,
    authStatus: "valid",
    expiresAt: null,
    billingStatus: "fresh",
    included: { usedPercent: 20, remainingPercent: 80, periodType: "weekly", periodStart: null, resetsAt: "2026-09-08T00:00:00Z" },
    prepaid: { balanceUsd: 12 },
    payg: null,
    subscriptionTier: "SuperGrok",
    observedAtMs: NOW,
    lastGoodAtMs: NOW,
    stale: false,
    error: null,
    ...overrides,
  };
}

function observation(accounts: GrokAccountView[] = [account()]): GrokObservation {
  return {
    schema_version: 1,
    observed_at_ms: NOW - 1_000,
    health: "ok",
    dependency: { name: "grok-swap", healthy: true },
    accounts,
    notes: [],
  };
}

function fakeGrokSwap(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentusage-grok-swap-")), "grok-swap");
  writeFileSync(path, `#!/usr/bin/env bun\n${script}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function success(dryRun: boolean, accountName = "grok-1"): string {
  return `console.log(JSON.stringify({schema_version:1,ok:true,command:"select",provider:"grok",data:{mode:"best",account:{accountKey:"grok-account:one",displayName:${JSON.stringify(accountName)},alias:"work",email:"grok@example.com"},reason:"included allowance",score:{tier:"included",remainingIncludedPercent:80,remainingDollars:null},dryRun:${JSON.stringify(dryRun)},reservation:${dryRun ? "null" : '{id:"reserve-1",createdAt:"2026-09-04T14:00:00Z",expiresAt:"2026-09-04T14:00:42Z"}'}}}));`;
}

describe("selectGrokAccount", () => {
  test("plain selection delegates strategy as a non-reserving dry run", async () => {
    const bin = fakeGrokSwap(`
const args = Bun.argv.slice(2);
if (!args.includes("--dry-run") || args[args.indexOf("--mode") + 1] !== "next-available") process.exit(9);
${success(true)}`);
    const result = await selectGrokAccount({
      strategy: "next-available",
      env: { AGENTUSAGE_GROK_SWAP_BIN: bin },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.displayName).toBe("grok-1");
      expect(result.dryRun).toBe(true);
      expect(result.reservation).toBeNull();
    }
  });

  test("claim translates to a bounded provider reservation", async () => {
    const bin = fakeGrokSwap(`
const args = Bun.argv.slice(2);
if (args.includes("--dry-run") || args[args.indexOf("--reserve-seconds") + 1] !== "42") process.exit(9);
${success(false)}`);
    const result = await selectGrokAccount({
      claim: true,
      reserveSeconds: 42,
      env: { AGENTUSAGE_GROK_SWAP_BIN: bin },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reservation?.id).toBe("reserve-1");
  });

  test("active focus exact-pins an eligible account", async () => {
    const bin = fakeGrokSwap(`
const args = Bun.argv.slice(2);
if (args[args.indexOf("--account") + 1] !== "grok-account:one") process.exit(9);
${success(true)}`);
    const focus: FocusStatus<FullFocusPolicy, FullFocusEffectiveState> = {
      state: "active",
      policy: materializeFullFocusPolicy("grok", "grok-account:one", { kind: "permanent" }, NOW),
      diagnostic: "none",
    };
    const result = await selectGrokAccount({
      observation: observation(),
      focus,
      nowMs: NOW,
      env: { AGENTUSAGE_GROK_SWAP_BIN: bin },
    });
    expect(result.ok && result.reason).toBe("full-focus");
  });

  test("an ineligible focused account falls back to ordinary provider selection", async () => {
    const bin = fakeGrokSwap(`
const args = Bun.argv.slice(2);
if (args.includes("--account")) process.exit(9);
${success(true, "grok-2")}`);
    const focus: FocusStatus<FullFocusPolicy, FullFocusEffectiveState> = {
      state: "active",
      policy: materializeFullFocusPolicy("grok", "grok-account:one", { kind: "permanent" }, NOW),
      diagnostic: "none",
    };
    const result = await selectGrokAccount({
      observation: observation([account({ enabled: false })]),
      focus,
      nowMs: NOW,
      env: { AGENTUSAGE_GROK_SWAP_BIN: bin },
    });
    expect(result.ok && result.reason).toBe("full-focus-fallback (included allowance)");
  });

  test("maps structured provider refusals", async () => {
    const bin = fakeGrokSwap(`console.log(JSON.stringify({schema_version:1,ok:false,command:"select",provider:"grok",error:{code:"no_eligible_account",message:"no room",details:{nextReadyAt:null}}})); process.exit(3);`);
    const result = await selectGrokAccount({ env: { AGENTUSAGE_GROK_SWAP_BIN: bin } });
    expect(result).toMatchObject({ ok: false, refusal: "no-eligible-account", detail: "no room" });
  });
});
