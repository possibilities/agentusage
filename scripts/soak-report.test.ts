import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStreak,
  computeDrifts,
  computeLatencyStats,
  listEnvelopeIds,
  listOrphanSessions,
  loadEvents,
  main,
  parseDurationMs,
  parseEventLine,
  resolveWindows,
  summarizeProfile,
} from "./soak-report";

describe("parseDurationMs", () => {
  test("parses unit suffixes", () => {
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("24h")).toBe(24 * 3_600_000);
    expect(parseDurationMs("7d")).toBe(7 * 86_400_000);
    expect(parseDurationMs("5m")).toBe(5 * 60_000);
    expect(parseDurationMs("250ms")).toBe(250);
  });

  test("bare number is seconds", () => {
    expect(parseDurationMs("30")).toBe(30_000);
  });

  test("rejects garbage", () => {
    expect(parseDurationMs("banana")).toBeNull();
    expect(parseDurationMs("24hh")).toBeNull();
  });
});

describe("resolveWindows", () => {
  const now = new Date("2026-07-06T12:00:00.000Z").getTime();

  test("since alone: a duration window ending at now", () => {
    const result = resolveWindows(now, "24h", null);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.since.endMs).toBe(now);
    expect(result.since.startMs).toBe(now - 24 * 3_600_000);
    expect(result.baseline).toBeNull();
  });

  test("since + baseline: baseline sits immediately before since with no gap", () => {
    const result = resolveWindows(now, "6h", "24h");
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.since.startMs).toBe(now - 6 * 3_600_000);
    if (result.baseline === null) {
      throw new Error("expected a baseline window");
    }
    expect(result.baseline.endMs).toBe(result.since.startMs);
    expect(result.baseline.startMs).toBe(result.since.startMs - 24 * 3_600_000);
  });

  test("since accepts an absolute ISO instant", () => {
    const result = resolveWindows(now, "2026-07-06T00:00:00.000Z", null);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.since.startMs).toBe(
      new Date("2026-07-06T00:00:00.000Z").getTime(),
    );
    expect(result.since.endMs).toBe(now);
  });

  test("bad since is a typed error, not a throw", () => {
    const result = resolveWindows(now, "not-a-duration", null);
    expect("error" in result).toBe(true);
  });

  test("bad baseline is a typed error", () => {
    const result = resolveWindows(now, "24h", "not-a-duration");
    expect("error" in result).toBe(true);
  });
});

describe("parseEventLine", () => {
  test("parses a well-formed line", () => {
    const line =
      '{"ts":"2026-07-06T00:00:00-04:00","id":"codex","target":"codex","event":"scraped","next_fetch_at":"2026-07-06T00:01:00-04:00"}';
    const parsed = parseEventLine(line);
    expect(parsed?.id).toBe("codex");
    expect(parsed?.event).toBe("scraped");
  });

  test("null on blank line", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
  });

  test("null on malformed JSON (truncated line)", () => {
    expect(
      parseEventLine('{"ts":"2026-07-06T00:00:00-04:00","id":"codex"'),
    ).toBeNull();
  });

  test("null when required fields are missing", () => {
    expect(parseEventLine('{"ts":"2026-07-06T00:00:00-04:00"}')).toBeNull();
  });
});

describe("computeDrifts", () => {
  test("hand-computed drift between two scraped events", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:02:00-04:00",
      },
      {
        ts: "2026-07-06T00:03:30-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:05:30-04:00",
      },
    ];
    // scheduled 00:02:00, actual 00:03:30 -> 90s late.
    expect(computeDrifts(events)).toEqual([90]);
  });

  test("skips a pair when the predecessor has no next_fetch_at (older schema)", () => {
    const events = [
      { ts: "2026-07-06T00:00:00-04:00", id: "x", event: "scrape_failed" },
      {
        ts: "2026-07-06T00:03:00-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:05:00-04:00",
      },
    ];
    expect(computeDrifts(events)).toEqual([]);
  });

  test("clips a negative drift (fires before its own predecessor's schedule) to 0", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T12:00:00-04:00",
      },
      {
        ts: "2026-07-06T00:05:00-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:07:00-04:00",
      },
    ];
    expect(computeDrifts(events)).toEqual([0]);
  });

  test("ignores skip events as the CURRENT element (only attempts get a drift entry)", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:02:00-04:00",
      },
      {
        ts: "2026-07-06T00:02:30-04:00",
        id: "x",
        event: "idle_skipped",
        next_fetch_at: "2026-07-06T00:10:00-04:00",
      },
    ];
    expect(computeDrifts(events)).toEqual([]);
  });
});

describe("computeLatencyStats", () => {
  test("hand-computed percentiles over a known sample", () => {
    // Sorted: 10 20 30 40 50 60 70 80 90 100 (n=10).
    const drifts = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];
    const stats = computeLatencyStats(drifts);
    expect(stats.count).toBe(10);
    expect(stats.minS).toBe(10);
    expect(stats.maxS).toBe(100);
    // p50 index = ceil(0.5*10)-1 = 4 -> value 50.
    expect(stats.p50S).toBe(50);
    // p95 index = ceil(0.95*10)-1 = 9 -> value 100.
    expect(stats.p95S).toBe(100);
    // Over the 60s budget: 70, 80, 90, 100 -> 4.
    expect(stats.overBudgetCount).toBe(4);
  });

  test("empty sample is all-null, not a throw", () => {
    const stats = computeLatencyStats([]);
    expect(stats).toEqual({
      count: 0,
      minS: null,
      p50S: null,
      p95S: null,
      maxS: null,
      overBudgetCount: 0,
    });
  });
});

describe("buildStreak", () => {
  test("hand-built sequence and trailing run", () => {
    const events = [
      { ts: "t1", id: "x", event: "scraped" },
      { ts: "t2", id: "x", event: "scrape_failed" },
      { ts: "t3", id: "x", event: "scraped" },
      { ts: "t4", id: "x", event: "scraped" },
    ];
    const streak = buildStreak(events, 10);
    expect(streak.sequence).toBe(".x..");
    expect(streak.currentOutcome).toBe("ok");
    expect(streak.currentRun).toBe(2);
  });

  test("takes only the last n", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      ts: `t${i}`,
      id: "x",
      event: "scraped",
    }));
    const streak = buildStreak(events, 2);
    expect(streak.sequence).toBe("..");
  });

  test("no attempts is the null-outcome sentinel, not a throw", () => {
    const streak = buildStreak([], 10);
    expect(streak).toEqual({
      sequence: "",
      currentOutcome: null,
      currentRun: 0,
    });
  });
});

describe("summarizeProfile", () => {
  test("hand-computed counts, success rate, and error_kind histogram", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        target: "claude",
        event: "scraped",
        next_fetch_at: "2026-07-06T00:02:00-04:00",
      },
      {
        ts: "2026-07-06T00:05:00-04:00",
        id: "x",
        target: "claude",
        event: "scrape_failed",
        error_kind: "upstream_limited",
      },
      {
        ts: "2026-07-06T00:10:00-04:00",
        id: "x",
        target: "claude",
        event: "idle_skipped",
      },
    ];
    const window = {
      startMs: new Date("2026-07-06T00:00:00-04:00").getTime(),
      endMs: new Date("2026-07-06T01:00:00-04:00").getTime(),
    };
    const stats = summarizeProfile("x", events, window, 10);
    expect(stats.counts).toEqual({
      scraped: 1,
      scrape_failed: 1,
      idle_skipped: 1,
      rate_limited_skipped: 0,
    });
    // 1 of 2 attempts succeeded.
    expect(stats.successRate).toBe(0.5);
    expect(stats.errorKindHistogram).toEqual({ upstream_limited: 1 });
    expect(stats.target).toBe("claude");
  });

  test("no attempts -> null success rate, not division by zero", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        target: "claude",
        event: "idle_skipped",
      },
    ];
    const window = { startMs: 0, endMs: Number.MAX_SAFE_INTEGER };
    const stats = summarizeProfile("x", events, window, 10);
    expect(stats.successRate).toBeNull();
  });

  test("an explicit-budget-timeout message is counted separately from the error_kind histogram", () => {
    const events = [
      {
        ts: "2026-07-06T00:00:00-04:00",
        id: "x",
        target: "claude",
        event: "scrape_failed",
        error_kind: "runner_failed",
        message: "scrape exceeded 60000ms budget (SIGKILLed)",
      },
    ];
    const window = { startMs: 0, endMs: Number.MAX_SAFE_INTEGER };
    const stats = summarizeProfile("x", events, window, 10);
    expect(stats.budgetTimeoutCount).toBe(1);
    expect(stats.errorKindHistogram).toEqual({ runner_failed: 1 });
  });
});

describe("listOrphanSessions", () => {
  test("hand-computed age filters sessions past the threshold, never kills anything", async () => {
    const nowEpochS = 1_000_000;
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return {
        stdout: `claude-a-1-1 ${nowEpochS - 200}\nclaude-b-2-2 ${nowEpochS - 50}\n`,
        exitCode: 0,
      };
    };
    const orphans = await listOrphanSessions(run, 180, nowEpochS);
    expect(orphans).toEqual([{ name: "claude-a-1-1", ageS: 200 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("kill-session");
  });

  test("nonzero exit (no server) is zero orphans, not an error", async () => {
    const run = async () => ({ stdout: "", exitCode: 1 });
    expect(await listOrphanSessions(run, 180, 1_000_000)).toEqual([]);
  });
});

describe("listEnvelopeIds / loadEvents (real filesystem)", () => {
  test("reads envelope ids, excludes sidecars and picker.json; parses events.jsonl skipping malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "soak-report-test-"));
    try {
      writeFileSync(join(dir, "default.json"), "{}");
      writeFileSync(join(dir, "codex.json"), "{}");
      writeFileSync(join(dir, "codex.error.json"), "{}");
      writeFileSync(join(dir, "picker.json"), "{}");
      writeFileSync(
        join(dir, "events.jsonl"),
        [
          '{"ts":"2026-07-06T00:00:00-04:00","id":"codex","target":"codex","event":"scraped"}',
          "not json at all",
          '{"ts":"2026-07-06T00:01:00-04:00","id":"codex","target":"codex","event":"scrape_failed","error_kind":"panel_missing"}',
          "",
        ].join("\n"),
      );

      const ids = listEnvelopeIds(dir).sort();
      expect(ids).toEqual(["codex", "default"]);

      const events = loadEvents(dir);
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("scraped");
      expect(events[1].error_kind).toBe("panel_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing state dir is empty, not a throw", () => {
    expect(listEnvelopeIds("/nonexistent/does/not/exist")).toEqual([]);
    expect(loadEvents("/nonexistent/does/not/exist")).toEqual([]);
  });
});

describe("main (end-to-end, read-only)", () => {
  test("renders a report from a fixture state dir and never calls kill-session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soak-report-main-test-"));
    try {
      writeFileSync(join(dir, "codex.json"), "{}");
      const t0 = new Date("2026-07-06T00:00:00-04:00").getTime();
      writeFileSync(
        join(dir, "events.jsonl"),
        [
          JSON.stringify({
            ts: new Date(t0).toISOString(),
            id: "codex",
            target: "codex",
            event: "scraped",
            next_fetch_at: new Date(t0 + 60_000).toISOString(),
          }),
          JSON.stringify({
            ts: new Date(t0 + 90_000).toISOString(),
            id: "codex",
            target: "codex",
            event: "scraped",
            next_fetch_at: new Date(t0 + 150_000).toISOString(),
          }),
        ].join("\n"),
      );

      const tmuxCalls: string[][] = [];
      const deps = {
        tmuxRunner: async (args: string[]) => {
          tmuxCalls.push(args);
          return { stdout: "", exitCode: 1 };
        },
        nowMs: () => t0 + 200_000,
      };

      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured = "";
      process.stdout.write = ((chunk: string) => {
        captured += chunk;
        return true;
      }) as typeof process.stdout.write;
      let exitCode: number;
      try {
        exitCode = await main(
          ["--state-dir", dir, "--since", "1h", "--json"],
          deps,
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(captured);
      expect(parsed.profiles).toHaveLength(1);
      expect(parsed.profiles[0].id).toBe("codex");
      expect(parsed.profiles[0].counts.scraped).toBe(2);
      expect(parsed.orphan_sessions).toEqual([]);
      expect(tmuxCalls.every((args) => !args.includes("kill-session"))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bad --since is a typed exit-2 error, not a thrown exception", async () => {
    const deps = {
      tmuxRunner: async () => ({ stdout: "", exitCode: 1 }),
      nowMs: () => Date.now(),
    };
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let exitCode: number;
    try {
      exitCode = await main(["--since", "garbage"], deps);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(exitCode).toBe(2);
  });
});
