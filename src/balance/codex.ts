import { CODEX_OBSERVATION_FRESHNESS_CEILING_MS } from '../constants.ts';
import { statePaths } from '../paths.ts';
import { readPool, findAccount } from '../accounts/store.ts';
import { AccountError } from '../accounts/storage.ts';
import {
  activeCounts,
  changeLeases,
  issueLease,
  readLeases,
  type LeaseState,
  type IssuedLease,
} from '../service/leases.ts';
import {
  type CodexAccountView,
  type CodexObservation,
  laneHeadroomPercent,
  mainLane,
  sparkLane,
} from '../codex/types.ts';
import type {
  FocusStatus,
  FullFocusEffectiveState,
  FullFocusPolicy,
} from '../focus.ts';

export type CodexLease = IssuedLease;
export interface CodexSelectionSuccess {
  ok: true;
  lane: 'main' | 'codex-spark';
  accountKey: string;
  email: string | null;
  label: string | null;
  reason: string;
  score: number | null;
  lease: CodexLease | null;
  pool?: Array<{
    accountKey: string;
    headroomPercent: number;
    activeLeases: number;
  }>;
}
export type CodexRefusal =
  | 'no-eligible-account'
  | 'provider-error'
  | 'observation-unavailable'
  | 'observation-stale'
  | 'no-spark-capacity';
export interface CodexSelectionRefusal {
  ok: false;
  lane: 'main' | 'codex-spark';
  refusal: CodexRefusal;
  detail: string;
  nextReadyAt?: string | null;
  exclusions?: unknown[];
}
export type CodexSelection = CodexSelectionSuccess | CodexSelectionRefusal;
export interface SelectCodexOptions {
  model?: string;
  strategy?: 'best' | 'next-available';
  account?: string;
  claim?: boolean;
  allowUnknown?: boolean;
  env?: Record<string, string | undefined>;
  observation?: CodexObservation | null;
  focus?: FocusStatus<FullFocusPolicy, FullFocusEffectiveState> | null;
  nowMs?: number;
}
export function codexAuthEligible(a: CodexAccountView): boolean {
  return (
    a.present &&
    a.enabled &&
    !a.manuallyDisabled &&
    !a.reloginRequired &&
    !a.identityConflict
  );
}
function choose(
  observation: CodexObservation | null,
  lane: 'main' | 'codex-spark',
  options: SelectCodexOptions,
  focusTarget: string | null,
  counts?: Map<string, number>,
  lastSelected?: string,
): CodexSelection {
  const now = options.nowMs ?? Date.now();
  if (!observation || observation.health !== 'ok')
    return {
      ok: false,
      lane,
      refusal: 'observation-unavailable',
      detail: 'Codex selection needs a healthy observation',
    };
  if (
    now - observation.observed_at_ms > CODEX_OBSERVATION_FRESHNESS_CEILING_MS ||
    observation.observed_at_ms > now + 1000
  )
    return {
      ok: false,
      lane,
      refusal: 'observation-stale',
      detail: 'Codex observation is stale',
    };
  // Resolve identity before eligibility: an ambiguous email must not change
  // workspaces merely because one of its accounts is disabled or exhausted.
  let requestedKey: string | undefined;
  if (options.account !== undefined) {
    const matches = observation.accounts.filter((a) =>
      [a.accountKey, a.providerAccountId, a.email, a.label, String((a.ordinal ?? -1) + 1)]
        .includes(options.account),
    );
    if (matches.length !== 1)
      return {
        ok: false,
        lane,
        refusal: 'no-eligible-account',
        detail: 'Account selector must resolve to exactly one account',
      };
    requestedKey = matches[0]!.accountKey;
  }
  const pool: Array<{
    account: CodexAccountView;
    headroomPercent: number;
    activeLeases: number;
    score: number;
  }> = [];
  for (const a of observation.accounts) {
    if (!codexAuthEligible(a)) continue;
    if (requestedKey !== undefined && a.accountKey !== requestedKey) continue;
    const windows = lane === 'main' ? mainLane(a) : sparkLane(a);
    const fresh =
      a.measuredAtMs !== null &&
      a.measuredAtMs <= now + 1000 &&
      now - a.measuredAtMs <= CODEX_OBSERVATION_FRESHNESS_CEILING_MS &&
      a.usageStatus === 'ok';
    const trusted = fresh && (lane === 'codex-spark' || a.decisionGrade);
    const headroom = trusted && windows ? laneHeadroomPercent(windows) : null;
    if (lane === 'main' && a.limitReached === true) continue;
    if (headroom === 0) continue;
    if (headroom === null && !(lane === 'main' && options.allowUnknown))
      continue;
    const quotaBlockedUntil = a.quotaBlockedUntilMs?.[lane] ?? 0;
    if (quotaBlockedUntil > now) {
      const quotaBlockedAt = a.quotaBlockedAtMs?.[lane];
      // Fresh positive capacity is stronger evidence than a cooldown recorded
      // by an older observer. Timestamp-less blocks predate this field and
      // are reconciled by the first current measurement during upgrade.
      const measurementConfirmsRecovery =
        headroom !== null &&
        headroom > 0 &&
        (quotaBlockedAt === undefined ||
          (a.measuredAtMs !== null && a.measuredAtMs > quotaBlockedAt));
      if (!measurementConfirmsRecovery) continue;
    }
    const leases = counts?.get(a.accountKey) ?? a.activeLeases;
    pool.push({
      account: a,
      headroomPercent: headroom ?? 0,
      activeLeases: leases,
      score: (headroom ?? 0) - (lane === 'main' ? 5 * leases : 0),
    });
  }
  if (options.account && pool.length > 1)
    return {
      ok: false,
      lane,
      refusal: 'no-eligible-account',
      detail: 'Account selector is ambiguous',
    };
  if (!pool.length)
    return {
      ok: false,
      lane,
      refusal: lane === 'main' ? 'no-eligible-account' : 'no-spark-capacity',
      detail: options.account
        ? 'Requested account is unavailable or has no trusted capacity'
        : `No eligible account has ${lane} capacity`,
    };
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      a.activeLeases - b.activeLeases ||
      a.account.accountKey.localeCompare(b.account.accountKey),
  );
  const pinned = options.account
    ? pool[0]
    : pool.find((x) => x.account.accountKey === focusTarget);
  let chosen = pinned ?? pool[0]!;
  if (!pinned) {
    const candidates =
      options.strategy === 'next-available'
        ? pool
        : pool.filter(
            (x) =>
              Math.abs(x.score - pool[0]!.score) < 1e-9 &&
              x.activeLeases === pool[0]!.activeLeases,
          );
    candidates.sort((a, b) =>
      a.account.accountKey.localeCompare(b.account.accountKey),
    );
    chosen =
      candidates.find(
        (x) =>
          lastSelected !== undefined && x.account.accountKey > lastSelected,
      ) ?? candidates[0]!;
  }
  const reason = options.account
    ? 'requested-account'
    : pinned
      ? 'full-focus'
      : focusTarget
        ? `full-focus-fallback (${lane === 'main' ? 'headroom' : 'spark-headroom'})`
        : lane === 'main'
          ? options.strategy === 'next-available'
            ? 'next-available'
            : 'headroom'
          : 'spark-headroom';
  return {
    ok: true,
    lane,
    accountKey: chosen.account.accountKey,
    email: chosen.account.email,
    label: chosen.account.label,
    reason,
    score: chosen.score,
    lease: null,
    pool: pool.map((x) => ({
      accountKey: x.account.accountKey,
      headroomPercent: x.headroomPercent,
      activeLeases: x.activeLeases,
    })),
  };
}
export function chooseCodexWithLeases(
  observation: CodexObservation | null,
  lane: 'main' | 'codex-spark',
  options: SelectCodexOptions,
  state: LeaseState,
  focusTarget: string | null,
): CodexSelection {
  return choose(
    observation,
    lane,
    options,
    focusTarget,
    activeCounts(state),
    state.last_selected.codex,
  );
}
export async function selectCodexAccount(
  options: SelectCodexOptions = {},
): Promise<CodexSelection> {
  const focus =
    options.focus?.state === 'active'
      ? (options.focus.policy?.target ?? null)
      : null;
  return selectManaged(
    options.model && /spark/iu.test(options.model) ? 'codex-spark' : 'main',
    options,
    focus,
  );
}
async function selectManaged(
  lane: 'main' | 'codex-spark',
  options: SelectCodexOptions,
  focus: string | null,
): Promise<CodexSelection> {
  const paths = statePaths(options.env ?? process.env);
  const select = (s: LeaseState) => {
    const selection = chooseCodexWithLeases(
      options.observation ?? null,
      lane,
      options,
      s,
      focus,
    );
    if (!selection.ok || !options.claim) return selection;
    const account = findAccount(readPool(paths), 'codex', selection.accountKey);
    if (!account.enabled || account.auth_error)
      return {
        ok: false as const,
        lane,
        refusal: 'no-eligible-account' as const,
        detail: 'Selected account was disabled or requires login',
      };
    return {
      ...selection,
      lease: issueLease(s, 'codex', account.key, Date.now(), {
        pinned: options.account !== undefined,
        model: options.model,
      }),
    };
  };
  try {
    return options.claim
      ? await changeLeases(paths, select)
      : select(readLeases(paths));
  } catch (e) {
    return {
      ok: false,
      lane,
      refusal: 'provider-error',
      detail:
        e instanceof AccountError
          ? e.message
          : 'Cannot read managed account state',
    };
  }
}
export function selectCodexSpark(
  observation: CodexObservation,
  nowMs = Date.now(),
  focusTarget: string | null = null,
): CodexSelection {
  return choose(observation, 'codex-spark', { nowMs }, focusTarget);
}
export interface ClaimCodexSparkOptions {
  observation: CodexObservation;
  model: string;
  focusTarget: string | null;
  env?: Record<string, string | undefined>;
}
export async function claimCodexSpark(
  _selection: CodexSelectionSuccess,
  options: ClaimCodexSparkOptions,
): Promise<CodexSelection> {
  return selectManaged(
    'codex-spark',
    {
      observation: options.observation,
      env: options.env,
      claim: true,
      model: options.model,
    },
    options.focusTarget,
  );
}
