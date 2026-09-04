import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  GROK_OBSERVATION_FRESHNESS_CEILING_MS,
  OBSERVATION_FRESHNESS_CEILING_MS,
} from "./constants.ts";
import {
  displayNameForRouteId,
  MODEL_WINDOW_PREFIX,
  type NormalizedWindow,
  type Observation,
  SESSION_WINDOW,
  SPEND_WINDOW,
  WEEK_WINDOW,
} from "./claude/types.ts";
import { type CodexObservation, isSparkLane } from "./codex/types.ts";
import type { GrokObservation } from "./grok/types.ts";
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

export interface FactRow {
  label: string;
  value: string;
  tone: Tone;
}

export interface AccountCard {
  provider: "claude" | "codex" | "grok";
  name: string;
  detail: string | null;
  resetCreditsAvailable: number | null;
  resetCreditExpiryText?: string | null;
  status: string | null;
  dimmed: boolean;
  measuredAgo: string | null;
  meters: MeterRow[];
  facts?: FactRow[];
  focus: string[];
}

export interface ProviderSection {
  provider: "claude" | "codex" | "grok";
  health: string;
  ageText: string;
  fresh: boolean;
  cards: AccountCard[];
  notes: string[];
}

export interface FocusLine {
  kind: "fable" | "non-fable" | "claude" | "codex" | "grok";
  state: string;
  target: string | null;
  lifetime: string | null;
}

export interface UsageViewModel {
  nowMs: number;
  claude: ProviderSection | null;
  codex: ProviderSection | null;
  grok: ProviderSection | null;
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

/** "mm:ss" (or "h:mm:ss" past an hour); negatives clamp to 00:00. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
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
    const route = observation.routes.find((candidate) => candidate.id === id);
    const issue = observation.account_issues[id];
    const measurement = route ?? observation.account_measurements?.[id];
    const measuredAtMs = measurement?.measuredAtMs ?? null;
    // cswap owns per-account measurement cadence and reports whether a row is
    // still trusted through usageStatus. A route in a fresh observation is
    // therefore live even when an idle account's scheduled sample is old.
    const dimmed = issue !== undefined || !fresh;
    cards.push({
      provider: "claude",
      name: displayNameForRouteId(id),
      detail: capacityDetail(observation, id),
      resetCreditsAvailable: null,
      status: issue ?? null,
      dimmed,
      measuredAgo: measuredAtMs === null ? null : formatDurationMs(nowMs - measuredAtMs),
      meters: measurement === undefined ? [] : claudeMeters(measurement.windows, nowMs, dimmed),
      facts: [],
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

  observation.accounts.filter((account) => account.present).forEach((account, index) => {
    const dimmed = account.measurementSource === "last-good" || !account.decisionGrade || !fresh;
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
          tone: dimmed ? "muted" : sparkLane ? "spark" : toneForUtilization(utilization),
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
    const resetCreditExpiryText = describeResetCreditExpiry(
      account.resetCreditsAvailable ?? 0,
      account.resetCreditExpirations,
      nowMs,
    );
    cards.push({
      provider: "codex",
      name: `codex-${(account.ndyIndex ?? index) + 1}`,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
      resetCreditsAvailable: account.resetCreditsAvailable ?? null,
      resetCreditExpiryText,
      status,
      dimmed,
      measuredAgo: account.measuredAtMs === null ? null : formatDurationMs(nowMs - account.measuredAtMs),
      meters,
      facts: [],
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

function describeResetCreditExpiry(
  available: number,
  expirations: readonly (string | null)[] | undefined,
  nowMs: number,
): string | null {
  if (available <= 0 || expirations === undefined || expirations.length === 0) return null;
  const dated = expirations
    .filter((expiry): expiry is string => expiry !== null)
    .map((expiry) => Date.parse(expiry))
    .filter(Number.isFinite);
  if (dated.length > 0) {
    const countdown = formatDurationMs(Math.min(...dated) - nowMs);
    return available === 1 ? `expires ${countdown}` : `next expires ${countdown}`;
  }
  return expirations.length >= available ? "no expiry" : null;
}

// ---------------------------------------------------------------------------
// Grok

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function buildGrokSection(
  observation: GrokObservation,
  nowMs: number,
  focusBadges: Map<string, string[]>,
): ProviderSection {
  const ageMs = nowMs - observation.observed_at_ms;
  const fresh = observation.health === "ok" && ageMs <= GROK_OBSERVATION_FRESHNESS_CEILING_MS;
  const cards: AccountCard[] = observation.accounts.map((account) => {
    const dimmed =
      !fresh || !account.enabled || account.authStatus !== "valid" || account.billingStatus !== "fresh" || account.stale;
    const status = !account.enabled
      ? "disabled"
      : account.authStatus !== "valid"
        ? `auth-${account.authStatus}`
        : account.billingStatus !== "fresh"
          ? account.billingStatus
          : null;
    const meters: MeterRow[] = [];
    if (account.included !== null) {
      const period = account.included.periodType?.toLowerCase() ?? "included";
      meters.push({
        label: period === "included" ? period : `${period} included`,
        usedPercent: account.included.usedPercent,
        resetText: countdownTo(account.included.resetsAt, nowMs),
        tone: dimmed ? "muted" : toneForUtilization(
          account.included.usedPercent === null ? null : account.included.usedPercent / 100,
        ),
        spark: false,
      });
    }
    const facts: FactRow[] = [];
    if (
      account.prepaid?.balanceUsd !== null &&
      account.prepaid?.balanceUsd !== undefined &&
      account.prepaid.balanceUsd > 0
    ) {
      facts.push({
        label: "prepaid",
        value: `${usd(account.prepaid.balanceUsd)} available`,
        tone: dimmed ? "muted" : "plain",
      });
    }
    const payg = account.payg;
    if (payg?.enabled === true) {
      const values: string[] = [];
      if (payg.usedUsd !== null) values.push(`${usd(payg.usedUsd)} used`);
      if (payg.remainingUsd !== null) values.push(`${usd(payg.remainingUsd)} left`);
      if (payg.capUsd !== null) values.push(`${usd(payg.capUsd)} cap`);
      facts.push({
        label: "pay as you go",
        value: values.length > 0 ? values.join(" · ") : payg.enabled === true ? "enabled" : "unknown",
        tone: dimmed ? "muted" : "plain",
      });
    }
    const detailParts: string[] = [];
    if (account.subscriptionTier !== null) detailParts.push(account.subscriptionTier);
    const identity = account.alias ?? account.email;
    if (identity !== null) detailParts.push(identity);
    const measuredAtMs = account.stale ? account.lastGoodAtMs : account.observedAtMs ?? account.lastGoodAtMs;
    return {
      provider: "grok",
      name: account.displayName,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
      resetCreditsAvailable: null,
      status,
      dimmed,
      measuredAgo: measuredAtMs === null ? null : formatDurationMs(nowMs - measuredAtMs),
      meters,
      facts,
      focus: focusBadges.get(account.accountKey) ?? [],
    };
  });
  return {
    provider: "grok",
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
  grok: GrokObservation | null;
  fable: FocusStatus<FableFocusPolicy, FableFocusEffectiveState>;
  nonFable: FocusStatus<NonFableFocusPolicy, AccountFocusEffectiveState>;
  claudeFull: FocusStatus<FullFocusPolicy, FullFocusEffectiveState>;
  codexFull: FocusStatus<FullFocusPolicy, FullFocusEffectiveState>;
  grokFull: FocusStatus<FullFocusPolicy, FullFocusEffectiveState>;
  nowMs: number;
}

export function buildViewModel(input: BuildViewModelInput): UsageViewModel {
  const claudeBadges = new Map<string, string[]>();
  const codexBadges = new Map<string, string[]>();
  const grokBadges = new Map<string, string[]>();
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
  if (input.grokFull.state === "active" && input.grokFull.policy !== null) {
    badge(grokBadges, input.grokFull.policy.target, "all⤳");
  }
  if (input.fable.state === "active" && input.fable.policy !== null) {
    badge(claudeBadges, input.fable.policy.target_route, "fable⤳");
  }
  if (input.nonFable.state === "active" && input.nonFable.policy !== null) {
    badge(claudeBadges, input.nonFable.policy.target_route, "non-fable⤳");
  }

  // Focus lines name the same account the cards do: route ids and codex
  // accountKeys are storage identities, display names are what operators read.
  const codexName = (accountKey: string): string => {
    const index = input.codex?.accounts.findIndex((account) => account.accountKey === accountKey) ?? -1;
    if (index < 0) return accountKey;
    return `codex-${(input.codex?.accounts[index]?.ndyIndex ?? index) + 1}`;
  };
  const grokName = (accountRef: string): string =>
    input.grok?.accounts.find(
      (account) => account.accountKey === accountRef || account.displayName === accountRef,
    )?.displayName ?? accountRef;

  const focus: FocusLine[] = [
    {
      kind: "claude",
      state: input.claudeFull.state,
      target: input.claudeFull.policy === null ? null : displayNameForRouteId(input.claudeFull.policy.target),
      lifetime: input.claudeFull.policy === null ? null : lifetimeText(input.claudeFull.policy, input.nowMs),
    },
    {
      kind: "codex",
      state: input.codexFull.state,
      target: input.codexFull.policy === null ? null : codexName(input.codexFull.policy.target),
      lifetime: input.codexFull.policy === null ? null : lifetimeText(input.codexFull.policy, input.nowMs),
    },
    {
      kind: "grok",
      state: input.grokFull.state,
      target: input.grokFull.policy === null ? null : grokName(input.grokFull.policy.target),
      lifetime: input.grokFull.policy === null ? null : lifetimeText(input.grokFull.policy, input.nowMs),
    },
    {
      kind: "fable",
      state: input.fable.state,
      target: input.fable.policy === null ? null : displayNameForRouteId(input.fable.policy.target_route),
      lifetime: input.fable.policy === null ? null : lifetimeText(input.fable.policy, input.nowMs),
    },
    {
      kind: "non-fable",
      state: input.nonFable.state,
      target: input.nonFable.policy === null ? null : displayNameForRouteId(input.nonFable.policy.target_route),
      lifetime: input.nonFable.policy === null ? null : lifetimeText(input.nonFable.policy, input.nowMs),
    },
  ];

  return {
    nowMs: input.nowMs,
    claude: input.claude === null ? null : buildClaudeSection(input.claude, input.nowMs, claudeBadges),
    codex: input.codex === null ? null : buildCodexSection(input.codex, input.nowMs, codexBadges),
    grok: input.grok === null ? null : buildGrokSection(input.grok, input.nowMs, grokBadges),
    focus,
  };
}
