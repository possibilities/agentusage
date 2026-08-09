import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  OBSERVATION_FRESHNESS_CEILING_MS,
  ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
} from "./constants.ts";
import {
  MODEL_WINDOW_PREFIX,
  type NormalizedWindow,
  type Observation,
  SESSION_WINDOW,
  SPEND_WINDOW,
  WEEK_WINDOW,
} from "./claude/types.ts";
import { type CodexObservation, isSparkLane } from "./codex/types.ts";
import type {
  AccountFocusEffectiveState,
  FableFocusEffectiveState,
  FableFocusPolicy,
  FocusStatus,
  FullFocusEffectiveState,
  FullFocusPolicy,
  NonFableFocusPolicy,
} from "./focus.ts";

/** Pure display model shared by the TUI, snapshot frame, and status output. */

export type Tone = "good" | "warn" | "hot" | "over" | "muted" | "accent" | "spark" | "plain";

export interface MeterRow {
  label: string;
  usedPercent: number | null;
  resetText: string | null;
  tone: Tone;
  spark: boolean;
}

export interface AccountCard {
  provider: "claude" | "codex";
  name: string;
  detail: string | null;
  status: string | null;
  stale: boolean;
  measuredAgo: string | null;
  meters: MeterRow[];
  focus: string[];
}

export interface ProviderSection {
  provider: "claude" | "codex";
  health: string;
  ageText: string;
  fresh: boolean;
  cards: AccountCard[];
  notes: string[];
}

export interface FocusLine {
  kind: "fable" | "non-fable" | "claude" | "codex";
  state: string;
  target: string | null;
  lifetime: string | null;
}

export interface UsageViewModel {
  nowMs: number;
  claude: ProviderSection | null;
  codex: ProviderSection | null;
  focus: FocusLine[];
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function countdownTo(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  return formatDurationMs(resetMs - nowMs);
}

export function toneForUtilization(utilization: number | null): Tone {
  if (utilization === null) return "muted";
  if (utilization >= 1) return "over";
  if (utilization >= 0.8) return "hot";
  if (utilization >= 0.5) return "warn";
  return "good";
}

// ---------------------------------------------------------------------------
// Claude

function claudeMeterLabel(key: string): string {
  if (key === SESSION_WINDOW) return "session";
  if (key === WEEK_WINDOW) return "weekly";
  if (key === SPEND_WINDOW) return "spend";
  if (key.startsWith(MODEL_WINDOW_PREFIX)) return key.slice(MODEL_WINDOW_PREFIX.length);
  return key;
}

const CLAUDE_WINDOW_ORDER: Record<string, number> = { [SESSION_WINDOW]: 0, [WEEK_WINDOW]: 1, [SPEND_WINDOW]: 2 };

function claudeMeters(windows: readonly NormalizedWindow[], nowMs: number, muted: boolean): MeterRow[] {
  const sorted = [...windows].sort((a, b) => {
    const orderA = CLAUDE_WINDOW_ORDER[a.key] ?? (a.key === "model:fable" ? 3 : 4);
    const orderB = CLAUDE_WINDOW_ORDER[b.key] ?? (b.key === "model:fable" ? 3 : 4);
    return orderA - orderB || a.key.localeCompare(b.key);
  });
  return sorted.map((window) => ({
    label: claudeMeterLabel(window.key),
    usedPercent: window.utilization * 100,
    resetText: countdownTo(window.resetsAt, nowMs),
    tone: muted ? "muted" : toneForUtilization(window.utilization),
    spark: false,
  }));
}

function capacityDetail(observation: Observation, id: string): string | null {
  const capacity = observation.account_capacity?.[id];
  if (capacity === undefined) return null;
  if (capacity.subscriptionType === "max") {
    return capacity.rateLimitMultiplier !== undefined ? `Max ${capacity.rateLimitMultiplier}×` : "Max";
  }
  if (capacity.subscriptionType === "pro") return "Pro";
  return capacity.rateLimitMultiplier !== undefined ? `${capacity.rateLimitMultiplier}×` : null;
}

function buildClaudeSection(
  observation: Observation,
  nowMs: number,
  focusBadges: Map<string, string[]>,
): ProviderSection {
  const ageMs = nowMs - observation.observed_at_ms;
  const fresh = observation.health === "ok" && ageMs <= OBSERVATION_FRESHNESS_CEILING_MS;
  const cards: AccountCard[] = [];
  const orderedIds = Object.entries(observation.claude_accounts.ordinals)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);

  for (const id of orderedIds) {
    const ordinal = observation.claude_accounts.ordinals[id] ?? 0;
    const route = observation.routes.find((candidate) => candidate.id === id);
    const issue = observation.account_issues[id];
    const measurement = route ?? observation.account_measurements?.[id];
    const measuredAtMs = measurement?.measuredAtMs ?? null;
    const measurementStale =
      measuredAtMs !== null && nowMs - measuredAtMs > ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS;
    const muted = issue !== undefined || measurementStale || !fresh;
    cards.push({
      provider: "claude",
      name: `c${ordinal}`,
      detail: capacityDetail(observation, id),
      status: issue ?? null,
      stale: muted,
      measuredAgo: measuredAtMs === null ? null : formatDurationMs(nowMs - measuredAtMs),
      meters: measurement === undefined ? [] : claudeMeters(measurement.windows, nowMs, muted),
      focus: focusBadges.get(id) ?? [],
    });
  }
  return {
    provider: "claude",
    health: observation.health,
    ageText: sectionAgeText(observation.health, fresh, ageMs),
    fresh,
    cards,
    notes: observation.notes,
  };
}

function sectionAgeText(health: string, fresh: boolean, ageMs: number): string {
  if (health !== "ok") return `${formatDurationMs(ageMs)} ago`;
  return `${fresh ? "fresh" : "stale"} ${formatDurationMs(ageMs)}`;
}

// ---------------------------------------------------------------------------
// Codex

function buildCodexSection(
  observation: CodexObservation,
  nowMs: number,
  focusBadges: Map<string, string[]>,
): ProviderSection {
  const ageMs = nowMs - observation.observed_at_ms;
  const fresh = observation.health === "ok" && ageMs <= CODEX_OBSERVATION_FRESHNESS_CEILING_MS;
  const cards: AccountCard[] = [];

  observation.accounts.forEach((account, index) => {
    const displayStale = account.measurementSource === "last-good" || !account.decisionGrade || !fresh;
    const status =
      account.reloginRequired
        ? "relogin-required"
        : account.identityConflict
          ? "identity-conflict"
          : account.manuallyDisabled
            ? "disabled"
            : account.usageStatus !== "ok"
              ? account.usageStatus
              : null;
    const meters: MeterRow[] = [];
    for (const lane of account.lanes) {
      const sparkLane = isSparkLane(lane);
      for (const window of lane.windows) {
        const utilization = window.usedPercent / 100;
        const prefix = lane.id === "main" ? "" : sparkLane ? "spark · " : `${lane.title.toLowerCase()} · `;
        meters.push({
          label: `${prefix}${window.label}`,
          usedPercent: window.usedPercent,
          resetText:
            countdownTo(window.resetsAt, nowMs) ??
            (window.resetAfterSeconds === null ? null : formatDurationMs(window.resetAfterSeconds * 1000)),
          tone: displayStale ? "muted" : sparkLane ? "spark" : toneForUtilization(utilization),
          spark: sparkLane,
        });
      }
    }
    const detailParts: string[] = [];
    if (account.planType !== null) {
      detailParts.push(account.planType.charAt(0).toUpperCase() + account.planType.slice(1));
    }
    const identity = account.label ?? account.email;
    if (identity !== null) detailParts.push(identity);
    cards.push({
      provider: "codex",
      name: `Codex ${account.ndyIndex ?? index + 1}`,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
      status,
      stale: displayStale,
      measuredAgo: account.measuredAtMs === null ? null : formatDurationMs(nowMs - account.measuredAtMs),
      meters,
      focus: focusBadges.get(account.accountKey) ?? [],
    });
  });

  return {
    provider: "codex",
    health: observation.health,
    ageText: sectionAgeText(observation.health, fresh, ageMs),
    fresh,
    cards,
    notes: observation.notes,
  };
}

// ---------------------------------------------------------------------------
// Focus chapter

function lifetimeText(policy: FableFocusPolicy | NonFableFocusPolicy | FullFocusPolicy, nowMs: number): string {
  const lifetime = policy.lifetime;
  if (lifetime.kind === "permanent") return "permanent";
  if (lifetime.kind === "absolute") return `until ${lifetimeCountdown(lifetime.deadline_at, nowMs)}`;
  return `cycle-end ${lifetimeCountdown(lifetime.reset_at, nowMs)}`;
}

function lifetimeCountdown(iso: string, nowMs: number): string {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return iso;
  return target <= nowMs ? "elapsed" : `${formatDurationMs(target - nowMs)}`;
}

export interface BuildViewModelInput {
  claude: Observation | null;
  codex: CodexObservation | null;
  fable: FocusStatus<FableFocusPolicy, FableFocusEffectiveState>;
  nonFable: FocusStatus<NonFableFocusPolicy, AccountFocusEffectiveState>;
  claudeFull: FocusStatus<FullFocusPolicy, FullFocusEffectiveState>;
  codexFull: FocusStatus<FullFocusPolicy, FullFocusEffectiveState>;
  nowMs: number;
}

export function buildViewModel(input: BuildViewModelInput): UsageViewModel {
  const claudeBadges = new Map<string, string[]>();
  const codexBadges = new Map<string, string[]>();
  const badge = (map: Map<string, string[]>, key: string, text: string): void => {
    const existing = map.get(key) ?? [];
    existing.push(text);
    map.set(key, existing);
  };
  if (input.claudeFull.state === "active" && input.claudeFull.policy !== null) {
    badge(claudeBadges, input.claudeFull.policy.target, "all⤳");
  }
  if (input.codexFull.state === "active" && input.codexFull.policy !== null) {
    badge(codexBadges, input.codexFull.policy.target, "all⤳");
  }
  if (input.fable.state === "active" && input.fable.policy !== null) {
    badge(claudeBadges, input.fable.policy.target_route, "fable⤳");
  }
  if (input.nonFable.state === "active" && input.nonFable.policy !== null) {
    badge(claudeBadges, input.nonFable.policy.target_route, "non-fable⤳");
  }

  const focus: FocusLine[] = [
    {
      kind: "claude",
      state: input.claudeFull.state,
      target: input.claudeFull.policy?.target ?? null,
      lifetime: input.claudeFull.policy === null ? null : lifetimeText(input.claudeFull.policy, input.nowMs),
    },
    {
      kind: "codex",
      state: input.codexFull.state,
      target: input.codexFull.policy?.target ?? null,
      lifetime: input.codexFull.policy === null ? null : lifetimeText(input.codexFull.policy, input.nowMs),
    },
    {
      kind: "fable",
      state: input.fable.state,
      target: input.fable.policy?.target_route ?? null,
      lifetime: input.fable.policy === null ? null : lifetimeText(input.fable.policy, input.nowMs),
    },
    {
      kind: "non-fable",
      state: input.nonFable.state,
      target: input.nonFable.policy?.target_route ?? null,
      lifetime: input.nonFable.policy === null ? null : lifetimeText(input.nonFable.policy, input.nowMs),
    },
  ];

  return {
    nowMs: input.nowMs,
    claude: input.claude === null ? null : buildClaudeSection(input.claude, input.nowMs, claudeBadges),
    codex: input.codex === null ? null : buildCodexSection(input.codex, input.nowMs, codexBadges),
    focus,
  };
}
