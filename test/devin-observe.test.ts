import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devinServiceUrl, observeDevin, usageFromStatus } from "../src/devin/observe.ts";
import { validateDevinObservation } from "../src/devin/types.ts";
import { refreshDevinObservation } from "../src/observe.ts";
import { buildViewModel } from "../src/view.ts";
import { linesToText, renderFrameLines } from "../src/render.ts";
import { fixtureState } from "./managed-fixtures.ts";

const NOW = Date.parse("2026-09-22T16:00:00Z");

function statusReply(extra: Record<string, unknown> = {}) {
  return {
    userStatus: {
      pro: true,
      name: "Test User",
      email: "devin@example.test",
      teamId: "devin-team$account-SECRETID",
      teamsTier: "TEAMS_TIER_DEVIN_PRO",
      planStatus: {
        planInfo: {
          teamsTier: "TEAMS_TIER_DEVIN_PRO",
          planName: "Pro",
          billingStrategy: "BILLING_STRATEGY_QUOTA",
          monthlyPromptCredits: -1,
          hideWeeklyQuota: false,
          devinInfo: {
            orgId: "org-SECRETID",
            apiUrl: "https://api.devin.ai",
            webappHost: "app.devin.ai",
            accountDisplayName: "Test User",
            requestUsageAction: { kind: "KIND_TEXT_ONLY", label: "Ask your account admin to raise it" },
          },
        },
        planStart: "2026-09-23T02:47:53Z",
        planEnd: "2026-10-23T02:47:53Z",
        availablePromptCredits: -1,
        dailyQuotaRemainingPercent: 72.5,
        weeklyQuotaRemainingPercent: 40,
        dailyQuotaResetAtUnix: "1790150400",
        weeklyQuotaResetAtUnix: "1790496000",
      },
      ...extra,
    },
  };
}

const off = { state: "off", policy: null, diagnostic: "none" } as never;

function credentialsFile(root: string, apiServer = "https://server.codeium.com"): string {
  const path = join(root, "credentials.toml");
  writeFileSync(
    path,
    `api_server_url = "${apiServer}"\ndevin_api_url = "https://api.devin.ai"\ndevin_webapp_host = "app.devin.ai"\nwindsurf_api_key = "test-key-SECRET"\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

function okFetch(reply: unknown = statusReply()) {
  return async () => Response.json(reply);
}

describe("Devin usage", () => {
  test("keeps only the allowlisted quota fields and drops ids, emails and URLs", () => {
    const usage = usageFromStatus(statusReply());
    expect(usage).toMatchObject({
      planLabel: "Pro",
      billing: "quota",
      dailyRemainingPercent: 72.5,
      weeklyRemainingPercent: 40,
      dailyResetsAt: new Date(1_790_150_400_000).toISOString(),
      weeklyResetsAt: new Date(1_790_496_000_000).toISOString(),
      periodStart: "2026-09-23T02:47:53.000Z",
      periodEnd: "2026-10-23T02:47:53.000Z",
      promptCreditsMonthly: -1,
      promptCreditsAvailable: -1,
      weeklyQuotaHidden: false,
      displayName: "Test User",
    });
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain("SECRETID");
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("org-");
  });

  test("refuses responses without a plan status", () => {
    expect(usageFromStatus({})).toBeNull();
    expect(usageFromStatus({ userStatus: {} })).toBeNull();
    expect(usageFromStatus(null)).toBeNull();
  });

  test("retains depleted quota meters when proto3 omits zero percentages", () => {
    const reply = statusReply();
    const planStatus = reply.userStatus.planStatus;
    const { dailyQuotaRemainingPercent: _daily, weeklyQuotaRemainingPercent: _weekly, ...depleted } = planStatus;
    const usage = usageFromStatus({ userStatus: { planStatus: depleted } });
    expect(usage).toMatchObject({ dailyRemainingPercent: 0, weeklyRemainingPercent: 0 });
    const observation = validateDevinObservation({
      schema_version: 1, observed_at_ms: NOW, health: "ok", stale: false, error: null, notes: [], usage,
    });
    expect(observation).not.toBeNull();
    const view = buildViewModel({
      claude: null, codex: null, grok: null, grokBot: null, devin: observation,
      fable: off, nonFable: off, claudeFull: off, codexFull: off, grokFull: off, nowMs: NOW,
    });
    const card = view.devin!.cards[0]!;
    expect(card.status).toBe("spent");
    expect(card.meters.map((meter) => meter.usedPercent)).toEqual([100, 100]);
    const text = linesToText(renderFrameLines(view, 80, { title: false }), false);
    for (const label of ["daily quota", "weekly quota"]) {
      expect(text.split("\n").find((line) => line.includes(label))).toMatch(/▕█+▏\s+100%/);
    }

    // Missing or malformed window evidence must not turn unknown quota into spent.
    expect(usageFromStatus({ userStatus: { planStatus: { planInfo: {}, dailyQuotaResetAtUnix: "bad" } } }))
      .toMatchObject({ dailyRemainingPercent: null, weeklyRemainingPercent: null });
    expect(usageFromStatus({ userStatus: { planStatus: { planInfo: {}, dailyQuotaResetAtUnix: "1790150400", dailyQuotaRemainingPercent: null } } }))
      .toMatchObject({ dailyRemainingPercent: null });
    expect(usageFromStatus({ userStatus: { planStatus: { planInfo: {}, dailyQuotaRemainingPercent: 0 } } }))
      .toMatchObject({ dailyRemainingPercent: 0, weeklyRemainingPercent: null });
  });

  test("reports absent when no Devin login is installed", async () => {
    const fixture = fixtureState();
    const observation = await observeDevin({
      nowMs: NOW,
      env: { ...fixture.env, AGENTUSAGE_DEVIN_CREDENTIALS: join(fixture.root, "missing.toml") },
    });
    expect(observation.health).toBe("absent");
    expect(observation.error?.code).toBe("not_logged_in");
    expect(observation.usage).toBeNull();
  });

  test("keeps the last good quota when the next read fails", async () => {
    const fixture = fixtureState();
    const env = { ...fixture.env, AGENTUSAGE_DEVIN_CREDENTIALS: credentialsFile(fixture.root) };
    const first = await observeDevin({ nowMs: NOW, env, fetch: okFetch() });
    const failing = async (): Promise<Response> => {
      throw new Error("network down");
    };
    const second = await observeDevin({ nowMs: NOW + 1_000, env, previous: first, fetch: failing });
    expect(second.health).toBe("stale");
    expect(second.stale).toBe(true);
    expect(second.usage?.dailyRemainingPercent).toBe(72.5);
    expect(JSON.stringify(second)).not.toContain("network down");
  });

  test("maps a rejected credential to a fixed error", async () => {
    const fixture = fixtureState();
    const env = { ...fixture.env, AGENTUSAGE_DEVIN_CREDENTIALS: credentialsFile(fixture.root) };
    const rejected = async () =>
      new Response(JSON.stringify({ code: "unauthenticated", message: "bad key test-key-SECRET" }), { status: 401 });
    const observation = await observeDevin({ nowMs: NOW, env, fetch: rejected });
    expect(observation.health).toBe("error");
    expect(observation.error?.code).toBe("auth_unavailable");
    expect(JSON.stringify(observation)).not.toContain("SECRET");
  });

  test("publishes a sidecar from a fixture login and loopback service", async () => {
    const fixture = fixtureState();
    let seen: { apiKey?: string; ideName?: string; connect?: string | null } = {};
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { metadata?: { apiKey?: string; ideName?: string } };
        seen = {
          apiKey: body.metadata?.apiKey,
          ideName: body.metadata?.ideName,
          connect: request.headers.get("connect-protocol-version"),
        };
        return Response.json(statusReply());
      },
    });
    try {
      const env = {
        ...fixture.env,
        AGENTUSAGE_DEVIN_CREDENTIALS: credentialsFile(fixture.root),
        AGENTUSAGE_TEST_DEVIN_ORIGIN: `http://127.0.0.1:${server.port}`,
      };
      const result = await refreshDevinObservation(fixture.paths, { freshWithinMs: 0, env });
      expect(result.outcome).toBe("refreshed");
      expect(seen).toMatchObject({ apiKey: "test-key-SECRET", ideName: "devin-cli", connect: "1" });
      expect(result.value?.health).toBe("ok");
      expect(validateDevinObservation(result.value)).not.toBeNull();
      expect(result.value?.usage?.weeklyRemainingPercent).toBe(40);
      const saved = JSON.stringify(result.value);
      expect(saved).not.toContain("test-key-SECRET");
      expect(saved).not.toContain("SECRETID");
    } finally {
      server.stop(true);
    }
  });

  test("refuses unsafe fixture origins and non-private credential files", async () => {
    const fixture = fixtureState();
    expect(() =>
      devinServiceUrl({ ...fixture.env, AGENTUSAGE_TEST_DEVIN_ORIGIN: "https://evil.example" }, "https://server.codeium.com"),
    ).toThrow();
    expect(() =>
      devinServiceUrl({ AGENTUSAGE_TEST_DEVIN_ORIGIN: "http://127.0.0.1:1" }, "https://server.codeium.com"),
    ).toThrow();
    const loose = join(fixture.root, "loose.toml");
    writeFileSync(loose, `api_server_url = "https://server.codeium.com"\nwindsurf_api_key = "k"\n`, { mode: 0o644 });
    chmodSync(loose, 0o644);
    // Vendor-written permission bits are tolerated; the file is read, never copied.
    const fromLoose = await observeDevin({
      nowMs: NOW,
      env: { ...fixture.env, AGENTUSAGE_DEVIN_CREDENTIALS: loose },
      fetch: okFetch(),
    });
    expect(fromLoose.health).toBe("ok");
    // A symlink or directory is still refused.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(loose, join(fixture.root, "linked.toml"));
    const linked = await observeDevin({
      nowMs: NOW,
      env: { ...fixture.env, AGENTUSAGE_DEVIN_CREDENTIALS: join(fixture.root, "linked.toml") },
      fetch: okFetch(),
    });
    expect(linked.health).toBe("error");
    expect(linked.error?.code).toBe("credentials_unreadable");
  });

  test("renders a Devin card with quota meters beside the other providers", () => {
    const observation = validateDevinObservation({
      schema_version: 1,
      observed_at_ms: NOW - 5_000,
      health: "ok",
      stale: false,
      error: null,
      notes: [],
      usage: usageFromStatus(statusReply()),
    });
    expect(observation).not.toBeNull();
    const view = buildViewModel({
      claude: null,
      codex: null,
      grok: null,
      grokBot: null,
      devin: observation,
      fable: off,
      nonFable: off,
      claudeFull: off,
      codexFull: off,
      grokFull: off,
      nowMs: NOW,
    });
    const card = view.devin!.cards[0]!;
    expect(card.name).toBe("devin-1");
    expect(card.detail).toBe("Pro · Test User");
    expect(card.meters[0]).toMatchObject({ label: "daily quota", usedPercent: 27.5 });
    expect(card.meters[1]).toMatchObject({ label: "weekly quota", usedPercent: 60 });
    const text = linesToText(renderFrameLines(view, 80, { title: false }), false);
    expect(text).toContain("devin-1");
    expect(text).toContain("daily quota");
    expect(text).toContain("weekly quota");
    expect(text).not.toContain("http");
    expect(text).not.toContain("SECRETID");
  });
});
