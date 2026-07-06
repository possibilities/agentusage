#!/usr/bin/env bun
/**
 * Read-only soak evidence report over `~/.local/state/agentusage/` — the
 * operator-phase tool that reads a `usage_scraper_runtime=bun` soak (or the
 * trailing `uv` baseline before it) and renders per-profile evidence: scrape
 * counts by arm, an `error_kind` histogram, a schedule-latency proxy vs the
 * 60s scrape budget, the last-N-cycle streak, and an orphaned-tmux check.
 *
 * NEVER triggers a scrape or writes state — every read here is a filesystem
 * read or a `tmux list-sessions` (no `kill-session`). This must stay true or
 * the report becomes part of the system it measures.
 *
 * `--since` selects the report window (default: trailing 24h). `--baseline`,
 * if given, selects a second window of that duration immediately BEFORE
 * `--since` starts, so the operator can compare a bun soak against the
 * trailing uv baseline without ever double-scraping the live `/usage` panel.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STATE_DIR = join(
  homedir(),
  ".local",
  "state",
  "agentusage",
);

// Mirrors `src/scrape.ts`'s dedicated tmux server (`TMUX_SOCKET`) and its
// `STALE_SESSION_SECONDS` sweep threshold (3x the scrape budget below) — kept
// as local constants rather than an import because this is a separate,
// read-only reporting concern from the scrape driver itself.
const TMUX_SOCKET = "agentusage-scrape";
const ORPHAN_THRESHOLD_S = 180;

// Mirrors keeper's `DEFAULT_SCRAPE_TIMEOUT_MS` (usage-scrape-runner.ts) — the
// per-scrape wall-clock budget past which the runner SIGKILLs the child.
const SCRAPE_BUDGET_S = 60;

const ATTEMPT_EVENTS = ["scraped", "scrape_failed"] as const;
type AttemptEvent = (typeof ATTEMPT_EVENTS)[number];
const SKIP_EVENTS = ["idle_skipped", "rate_limited_skipped"] as const;
type SkipEvent = (typeof SKIP_EVENTS)[number];
type EventKind = AttemptEvent | SkipEvent;
const ALL_EVENT_KINDS: EventKind[] = [...ATTEMPT_EVENTS, ...SKIP_EVENTS];

function isAttemptEvent(event: string): event is AttemptEvent {
  return (ATTEMPT_EVENTS as readonly string[]).includes(event);
}

/** One decoded `events.jsonl` line. Extra fields vary by `event`; kept loose. */
export interface RawEvent {
  ts: string;
  id: string;
  target?: string;
  event: string;
  next_fetch_at?: string;
  error_kind?: string;
  message?: string;
  [key: string]: unknown;
}

// ---------- pure helpers (unit-tested) --------------------------------------

/**
 * Parse a duration into milliseconds: `<number><s|m|h|d>` (`90s`, `24h`,
 * `7d`), or a bare number/decimal treated as seconds. `null` on anything else
 * (including an ISO timestamp — callers that accept an absolute instant parse
 * that themselves via {@link parseSinceBound}).
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  const withUnit = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (withUnit) {
    const value = Number.parseFloat(withUnit[1]);
    const unitMs: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return value * unitMs[withUnit[2]];
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1_000;
  }
  return null;
}

export interface Window {
  startMs: number;
  endMs: number;
}

/** `--since` accepts a duration (relative to `now`) OR an absolute ISO instant. */
function parseSinceBound(raw: string, nowMs: number): number | null {
  const asDuration = parseDurationMs(raw);
  if (asDuration !== null) {
    return nowMs - asDuration;
  }
  const asDate = new Date(raw);
  return Number.isNaN(asDate.getTime()) ? null : asDate.getTime();
}

/**
 * Resolve the report window(s). `since` ends at `now`; `baseline` (a duration
 * only — it is always relative) ends exactly where `since` starts, so the two
 * windows sit back-to-back with no overlap and no gap.
 */
export function resolveWindows(
  nowMs: number,
  sinceRaw: string,
  baselineRaw: string | null,
): { since: Window; baseline: Window | null } | { error: string } {
  const sinceStart = parseSinceBound(sinceRaw, nowMs);
  if (sinceStart === null) {
    return {
      error: `--since must be a duration (e.g. "24h") or an ISO timestamp, got ${JSON.stringify(sinceRaw)}`,
    };
  }
  const since: Window = { startMs: sinceStart, endMs: nowMs };
  if (baselineRaw === null) {
    return { since, baseline: null };
  }
  const baselineMs = parseDurationMs(baselineRaw);
  if (baselineMs === null) {
    return {
      error: `--baseline must be a duration (e.g. "7d"), got ${JSON.stringify(baselineRaw)}`,
    };
  }
  const baseline: Window = {
    startMs: sinceStart - baselineMs,
    endMs: sinceStart,
  };
  return { since, baseline };
}

function inWindow(tsMs: number, window: Window): boolean {
  return tsMs >= window.startMs && tsMs < window.endMs;
}

/** One `events.jsonl` line -> `RawEvent`, or `null` on anything malformed. */
export function parseEventLine(line: string): RawEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const rec = data as Record<string, unknown>;
  if (
    typeof rec.ts !== "string" ||
    typeof rec.id !== "string" ||
    typeof rec.event !== "string"
  ) {
    return null;
  }
  return rec as unknown as RawEvent;
}

export interface LatencyStats {
  count: number;
  minS: number | null;
  p50S: number | null;
  p95S: number | null;
  maxS: number | null;
  overBudgetCount: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Summarize a schedule-drift sample (see {@link computeDrifts}) into a
 * distribution vs the {@link SCRAPE_BUDGET_S} scrape budget.
 */
export function computeLatencyStats(driftsS: number[]): LatencyStats {
  if (driftsS.length === 0) {
    return {
      count: 0,
      minS: null,
      p50S: null,
      p95S: null,
      maxS: null,
      overBudgetCount: 0,
    };
  }
  const sorted = [...driftsS].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minS: sorted[0],
    p50S: percentile(sorted, 0.5),
    p95S: percentile(sorted, 0.95),
    maxS: sorted[sorted.length - 1],
    overBudgetCount: sorted.filter((s) => s > SCRAPE_BUDGET_S).length,
  };
}

/**
 * Schedule-drift proxy for per-scrape latency: the runtime logs no raw
 * per-attempt duration anywhere in the envelope/events contract, so this
 * measures how much LATER than its own prior `next_fetch_at` each attempt
 * actually fired — a rising drift is consistent with scrapes creeping toward
 * (or past) the {@link SCRAPE_BUDGET_S} wall-clock budget. `events` MUST
 * already be sorted ascending by `ts` and belong to a single profile id.
 * Negative drift (an attempt firing before its own predecessor's scheduled
 * time — clock skew, a manual re-run) is clipped to 0.
 */
export function computeDrifts(events: RawEvent[]): number[] {
  const drifts: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const cur = events[i];
    if (!isAttemptEvent(cur.event)) {
      continue;
    }
    const prevNextFetchAt = events[i - 1].next_fetch_at;
    if (!prevNextFetchAt) {
      continue;
    }
    const prevScheduled = new Date(prevNextFetchAt).getTime();
    const actual = new Date(cur.ts).getTime();
    if (Number.isNaN(prevScheduled) || Number.isNaN(actual)) {
      continue;
    }
    drifts.push(Math.max(0, (actual - prevScheduled) / 1000));
  }
  return drifts;
}

/** A `scrape_failed` whose message names the SIGKILL budget explicitly — the direct (non-proxy) timeout signal. */
const BUDGET_TIMEOUT_RE = /exceeded\s+\d+ms\s+budget/i;

export interface StreakInfo {
  /** Chronological (oldest -> newest), one char per attempt: `.` ok, `x` failed. */
  sequence: string;
  currentOutcome: "ok" | "error" | null;
  currentRun: number;
}

/** Last-N-cycle streak over the most recent `n` attempt events (any window). */
export function buildStreak(
  attemptEventsAsc: RawEvent[],
  n: number,
): StreakInfo {
  const tail = attemptEventsAsc.slice(-n);
  const sequence = tail
    .map((e) => (e.event === "scraped" ? "." : "x"))
    .join("");
  if (tail.length === 0) {
    return { sequence, currentOutcome: null, currentRun: 0 };
  }
  const lastOutcome: "ok" | "error" =
    tail[tail.length - 1].event === "scraped" ? "ok" : "error";
  let run = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const outcome: "ok" | "error" =
      tail[i].event === "scraped" ? "ok" : "error";
    if (outcome !== lastOutcome) {
      break;
    }
    run++;
  }
  return { sequence, currentOutcome: lastOutcome, currentRun: run };
}

export interface ProfileWindowStats {
  id: string;
  target: string | null;
  counts: Record<EventKind, number>;
  successRate: number | null;
  errorKindHistogram: Record<string, number>;
  budgetTimeoutCount: number;
  latency: LatencyStats;
  streak: StreakInfo;
}

/**
 * Summarize one profile's events within `window`. `allEventsAsc` is the
 * profile's FULL history (ascending by ts, any window) — the streak reads the
 * most recent `streakN` attempts regardless of window, while every other
 * field is scoped strictly to `window`, so a narrow `--since` still shows a
 * meaningful trailing streak.
 */
export function summarizeProfile(
  id: string,
  allEventsAsc: RawEvent[],
  window: Window,
  streakN: number,
): ProfileWindowStats {
  const inWin = allEventsAsc.filter((e) =>
    inWindow(new Date(e.ts).getTime(), window),
  );
  const target =
    inWin.find((e) => e.target)?.target ??
    allEventsAsc.find((e) => e.target)?.target ??
    null;

  const counts = Object.fromEntries(
    ALL_EVENT_KINDS.map((k) => [k, 0]),
  ) as Record<EventKind, number>;
  const errorKindHistogram: Record<string, number> = {};
  let budgetTimeoutCount = 0;
  for (const e of inWin) {
    if ((ALL_EVENT_KINDS as string[]).includes(e.event)) {
      counts[e.event as EventKind]++;
    }
    if (e.event === "scrape_failed") {
      const kind = e.error_kind ?? "unknown";
      errorKindHistogram[kind] = (errorKindHistogram[kind] ?? 0) + 1;
      if (typeof e.message === "string" && BUDGET_TIMEOUT_RE.test(e.message)) {
        budgetTimeoutCount++;
      }
    }
  }
  const attempts = counts.scraped + counts.scrape_failed;
  const successRate = attempts > 0 ? counts.scraped / attempts : null;

  const drifts = computeDrifts(inWin);
  const allAttempts = allEventsAsc.filter((e) => isAttemptEvent(e.event));
  const streak = buildStreak(allAttempts, streakN);

  return {
    id,
    target,
    counts,
    successRate,
    errorKindHistogram,
    budgetTimeoutCount,
    latency: computeLatencyStats(drifts),
    streak,
  };
}

// ---------- envelope / events loading ---------------------------------------

/** Profile ids with a live `<id>.json` envelope (excludes `.error.json` sidecars and `picker.json`). */
export function listEnvelopeIds(stateDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".error.json")) {
      continue;
    }
    const stem = name.slice(0, -".json".length);
    if (stem === "picker" || !/^[a-z0-9-]+$/.test(stem)) {
      continue;
    }
    ids.push(stem);
  }
  return ids;
}

/** Every parseable line of `events.jsonl`, in file order (which is append order — already ts-ascending). */
export function loadEvents(stateDir: string): RawEvent[] {
  let text: string;
  try {
    text = readFileSync(join(stateDir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: RawEvent[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseEventLine(line);
    if (parsed) {
      events.push(parsed);
    }
  }
  return events;
}

function groupById(events: RawEvent[]): Map<string, RawEvent[]> {
  const byId = new Map<string, RawEvent[]>();
  for (const e of events) {
    const list = byId.get(e.id);
    if (list) {
      list.push(e);
    } else {
      byId.set(e.id, [e]);
    }
  }
  return byId;
}

// ---------- orphaned-tmux check ----------------------------------------------

export interface OrphanSession {
  name: string;
  ageS: number;
}

export type TmuxRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

async function runTmux(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["tmux", "-L", TMUX_SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

/**
 * List sessions on the dedicated `agentusage-scrape` tmux server older than
 * `thresholdS` — the same 180s (3x scrape budget) sweep threshold the scrape
 * driver itself reaps at, so a session surfacing here is one that should
 * already have been swept by the next scrape's own sweep-on-boot and wasn't.
 * READ-ONLY: `list-sessions`, never `kill-session`. No server / no sessions
 * (nonzero exit) is reported as zero orphans, not an error.
 */
export async function listOrphanSessions(
  run: TmuxRunner,
  thresholdS: number,
  nowEpochS: number,
): Promise<OrphanSession[]> {
  const { stdout, exitCode } = await run([
    "list-sessions",
    "-F",
    "#{session_name} #{session_created}",
  ]);
  if (exitCode !== 0) {
    return [];
  }
  const orphans: OrphanSession[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const sep = trimmed.lastIndexOf(" ");
    if (sep < 0) {
      continue;
    }
    const name = trimmed.slice(0, sep);
    const created = Number.parseInt(trimmed.slice(sep + 1), 10);
    if (Number.isNaN(created)) {
      continue;
    }
    const ageS = nowEpochS - created;
    if (ageS > thresholdS) {
      orphans.push({ name, ageS });
    }
  }
  return orphans;
}

// ---------- rendering --------------------------------------------------------

function formatS(v: number | null): string {
  return v === null ? "n/a" : `${v.toFixed(1)}s`;
}

function formatPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function renderProfileBlock(label: string, stats: ProfileWindowStats): string {
  const lines: string[] = [];
  lines.push(`  ${label}`);
  lines.push(
    `    arm:          scraped=${stats.counts.scraped} scrape_failed=${stats.counts.scrape_failed} idle_skipped=${stats.counts.idle_skipped} rate_limited_skipped=${stats.counts.rate_limited_skipped}`,
  );
  lines.push(
    `    success rate: ${formatPct(stats.successRate)} (of ${stats.counts.scraped + stats.counts.scrape_failed} attempts)`,
  );
  const errorKinds = Object.entries(stats.errorKindHistogram);
  lines.push(
    `    error_kind:   ${errorKinds.length === 0 ? "(none)" : errorKinds.map(([k, n]) => `${k}=${n}`).join(" ")}`,
  );
  lines.push(
    `    latency:      n=${stats.latency.count} min=${formatS(stats.latency.minS)} p50=${formatS(stats.latency.p50S)} p95=${formatS(stats.latency.p95S)} max=${formatS(stats.latency.maxS)} over-${SCRAPE_BUDGET_S}s-drift=${stats.latency.overBudgetCount} explicit-budget-timeouts=${stats.budgetTimeoutCount}`,
  );
  lines.push(
    `    streak:       [${stats.streak.sequence || "(no attempts)"}] current=${stats.streak.currentOutcome ?? "n/a"}${stats.streak.currentOutcome ? `x${stats.streak.currentRun}` : ""}`,
  );
  return lines.join("\n");
}

function renderWindow(w: Window): string {
  return `${new Date(w.startMs).toISOString()} .. ${new Date(w.endMs).toISOString()}`;
}

// ---------- argv + main ------------------------------------------------------

interface ParsedArgs {
  stateDir: string;
  since: string;
  baseline: string | null;
  streakN: number;
  profileFilter: string[] | null;
  json: boolean;
  now: string | null;
}

function parseArgv(argv: string[]): ParsedArgs | { error: string } {
  let stateDir = DEFAULT_STATE_DIR;
  let since = "24h";
  let baseline: string | null = null;
  let streakN = 10;
  let profileFilter: string[] | null = null;
  let json = false;
  let now: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state-dir") {
      stateDir = argv[++i];
    } else if (arg === "--since") {
      since = argv[++i];
    } else if (arg === "--baseline") {
      baseline = argv[++i] ?? null;
    } else if (arg === "--streak-n") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: "--streak-n must be a positive integer" };
      }
      streakN = n;
    } else if (arg === "--profile") {
      profileFilter = (argv[++i] ?? "").split(",").filter((s) => s.length > 0);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--now") {
      now = argv[++i];
    } else {
      return { error: `unrecognized argument: ${arg}` };
    }
  }
  return { stateDir, since, baseline, streakN, profileFilter, json, now };
}

export interface MainDeps {
  tmuxRunner: TmuxRunner;
  nowMs: () => number;
}

const productionDeps: MainDeps = {
  tmuxRunner: runTmux,
  nowMs: () => Date.now(),
};

export async function main(
  argv: string[],
  deps: MainDeps = productionDeps,
): Promise<number> {
  const parsed = parseArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const nowMs = parsed.now ? new Date(parsed.now).getTime() : deps.nowMs();
  if (Number.isNaN(nowMs)) {
    process.stderr.write(`--now is not a parseable timestamp: ${parsed.now}\n`);
    return 2;
  }

  const windows = resolveWindows(nowMs, parsed.since, parsed.baseline);
  if ("error" in windows) {
    process.stderr.write(`${windows.error}\n`);
    return 2;
  }

  const envelopeIds = listEnvelopeIds(parsed.stateDir);
  const events = loadEvents(parsed.stateDir);
  const byId = groupById(events);
  const allIds = new Set<string>([...envelopeIds, ...byId.keys()]);
  let ids = [...allIds].sort();
  if (parsed.profileFilter) {
    const wanted = new Set(parsed.profileFilter);
    ids = ids.filter((id) => wanted.has(id));
  }

  const sinceStats = ids.map((id) =>
    summarizeProfile(id, byId.get(id) ?? [], windows.since, parsed.streakN),
  );
  const baselineStats = windows.baseline
    ? ids.map((id) =>
        summarizeProfile(
          id,
          byId.get(id) ?? [],
          windows.baseline as Window,
          parsed.streakN,
        ),
      )
    : null;

  const orphans = await listOrphanSessions(
    deps.tmuxRunner,
    ORPHAN_THRESHOLD_S,
    Math.floor(nowMs / 1000),
  );

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          state_dir: parsed.stateDir,
          since_window: windows.since,
          baseline_window: windows.baseline,
          profiles: sinceStats,
          baseline_profiles: baselineStats,
          orphan_sessions: orphans,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`agentusage soak report — state dir: ${parsed.stateDir}`);
  lines.push(`since window:    ${renderWindow(windows.since)}`);
  if (windows.baseline) {
    lines.push(`baseline window: ${renderWindow(windows.baseline)}`);
  }
  lines.push("");
  if (ids.length === 0) {
    lines.push("(no profiles found — no envelopes and no events in range)");
  }
  for (let i = 0; i < ids.length; i++) {
    lines.push(`${ids[i]} (${sinceStats[i].target ?? "unknown target"})`);
    lines.push(renderProfileBlock("since:", sinceStats[i]));
    if (baselineStats) {
      lines.push(renderProfileBlock("baseline:", baselineStats[i]));
    }
    lines.push("");
  }
  lines.push(
    `orphaned tmux sessions (>${ORPHAN_THRESHOLD_S}s old on -L ${TMUX_SOCKET}): ${orphans.length}`,
  );
  for (const o of orphans) {
    lines.push(`  ${o.name} — ${o.ageS.toFixed(0)}s old`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
