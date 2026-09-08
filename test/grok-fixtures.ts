import { join } from "node:path";
import type { NormalizedBilling, StoreState, StoredAccount } from "../src/grok/model.ts";
import type { StatePaths } from "../src/paths.ts";
import { withState } from "../src/grok/store.ts";
export function billing(overrides: Partial<NormalizedBilling> = {}): NormalizedBilling {
  return {
    included: { usedPercent: 25, remainingPercent: 75, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodStart: "2026-09-01T00:00:00.000Z", resetsAt: "2026-09-08T00:00:00.000Z" },
    prepaid: { balanceUsd: 0 },
    payg: { enabled: false, usedUsd: 0, capUsd: 0, remainingUsd: 0 },
    subscriptionTier: "SuperGrok",
    ...overrides,
  };
}

export function account(ordinal: number, observed: NormalizedBilling | null = billing(), now = Date.now()): StoredAccount {
  const key = `grok-${ordinal}`;
  return {
    accountKey: key,
    displayName: key,
    ordinal,
    alias: null,
    email: `user${ordinal}@example.test`,
    userId: `acct_${ordinal}`,
    enabled: true,
    credentials: {
      accessToken: `access-${ordinal}`,
      refreshToken: `refresh-${ordinal}`,
      expiresAtMs: now + 60 * 60_000,
      issuer: "https://auth.x.ai",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    },
    observation: {
      lastGood: observed ? { ...observed, observedAt: new Date(now).toISOString() } : null,
      lastAttemptAt: observed ? new Date(now).toISOString() : null,
      failureCount: 0,
      nextAttemptAtMs: null,
      error: null,
    },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export function state(accounts: StoredAccount[]): StoreState {
  return { version: 1, nextOrdinal: Math.max(0, ...accounts.map((a) => a.ordinal)) + 1, nextAvailableCursor: null, accounts, reservations: [] };
}

export async function seedGrok(paths: StatePaths, accounts: StoredAccount[], extra: Partial<StoreState> = {}): Promise<void> {
  await withState(paths, (stored) => {
    Object.assign(stored, state(accounts), extra);
    return { result: null, changed: true };
  });
}

export async function grokCli(args: string[], env: Record<string, string | undefined>) {
  if (!env.AGENTUSAGE_STATE_ROOT) throw new Error("A CLI fixture requires its isolated state root");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { code, stdout, stderr, data: stdout.trim() ? JSON.parse(stdout) : null };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}
