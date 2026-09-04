import { describe, expect, test } from "bun:test";
import { OBSERVATION_FRESHNESS_CEILING_MS } from "../src/constants.ts";
import {
  OBSERVATION_SCHEMA_VERSION,
  type AccountObservationIssue,
  type NormalizedWindow,
  type Observation,
  type Route,
} from "../src/claude/types.ts";
import { linesToText, renderFrameLines } from "../src/render.ts";
import { buildViewModel } from "../src/view.ts";

const NOW = Date.parse("2026-08-17T16:00:00Z");
const ID = "claude-swap:1";
const OFF = { state: "off", policy: null, raw: null } as never;
const WINDOWS: NormalizedWindow[] = [
  { key: "session", utilization: 0.2, resetsAt: "2026-08-17T19:30:00Z" },
  { key: "week", utilization: 0.4, resetsAt: "2026-08-18T00:00:00Z" },
];

function observation(options: {
  measuredAtMs: number;
  observedAtMs?: number;
  issue?: AccountObservationIssue;
}): Observation {
  const route: Route = {
    id: ID,
    kind: "managed",
    slot: 1,
    windows: WINDOWS,
    measuredAtMs: options.measuredAtMs,
  };
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: options.observedAtMs ?? NOW - 5_000,
    health: "ok",
    routes: options.issue === undefined ? [route] : [],
    claude_accounts: { count: 1, ordinals: { [ID]: 0 } },
    account_issues: options.issue === undefined ? {} : { [ID]: options.issue },
    account_measurements:
      options.issue === undefined
        ? undefined
        : { [ID]: { windows: WINDOWS, measuredAtMs: options.measuredAtMs } },
    notes: [],
  };
}

function build(claude: Observation) {
  return buildViewModel({
    claude,
    codex: null,
    grok: null,
    fable: OFF,
    nonFable: OFF,
    claudeFull: OFF,
    codexFull: OFF,
    grokFull: OFF,
    nowMs: NOW,
  });
}

describe("Claude card freshness", () => {
  test("keeps a provider-trusted route live when its scheduled sample is old", () => {
    const model = build(observation({ measuredAtMs: NOW - 11 * 60_000 }));
    const card = model.claude?.cards[0];

    expect(card?.dimmed).toBe(false);
    expect(card?.status).toBeNull();
    expect(card?.measuredAgo).toBe("11m");
    expect(card?.meters.map((meter) => meter.tone)).toEqual(["good", "good"]);
    expect(linesToText(renderFrameLines(model, 80, { title: false }), false)).toContain("● claude-1");
  });

  test("dims an account issue even when the provider observation is fresh", () => {
    const model = build(
      observation({ measuredAtMs: NOW - 11 * 60_000, issue: "usage-unavailable" }),
    );
    const card = model.claude?.cards[0];

    expect(card?.dimmed).toBe(true);
    expect(card?.status).toBe("usage-unavailable");
    expect(card?.meters.map((meter) => meter.tone)).toEqual(["muted", "muted"]);
    expect(linesToText(renderFrameLines(model, 80, { title: false }), false)).toContain(
      "○ claude-1  usage-unavailable",
    );
  });

  test("dims routes when the provider observation itself is stale", () => {
    const model = build(
      observation({
        measuredAtMs: NOW - 5_000,
        observedAtMs: NOW - OBSERVATION_FRESHNESS_CEILING_MS - 1,
      }),
    );

    expect(model.claude?.fresh).toBe(false);
    expect(model.claude?.cards[0]?.dimmed).toBe(true);
    expect(linesToText(renderFrameLines(model, 80, { title: false }), false)).toContain("○ claude-1");
  });
});
