import { existsSync } from 'node:fs';
import { accountLock, readPool, type ManagedAccount } from '../accounts/store.ts';
import { AccountError, withLock } from '../accounts/storage.ts';
import { buildCodexObservation } from '../codex/observe.ts';
import type { CodexAccountView, CodexObservation } from '../codex/types.ts';
import { buildGrokObservation } from '../grok/observe.ts';
import { credentialFingerprint } from '../grok/billing.ts';
import type { StoredAccount as GrokStoredAccount } from '../grok/model.ts';
import { lockPath as grokAccountLock, readState as readGrokState } from '../grok/store.ts';
import type { GrokAccountView, GrokObservation } from '../grok/types.ts';
import { readCodexObservation, readGrokObservation } from '../observe.ts';
import type { StatePaths } from '../paths.ts';
import {
  CODEX_PROVIDER_AUTHORITY_GENERATION,
  GROK_PROVIDER_AUTHORITY_GENERATION,
  ROUTING_EVIDENCE_SCHEMA_VERSION,
  RoutingEvidenceError,
  type RoutingEvidenceProjection,
} from './types.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutProvenance(observation: CodexObservation): unknown {
  const clone = structuredClone(observation) as CodexObservation;
  delete clone.source_revision;
  return clone;
}

function withoutGrokProvenance(observation: GrokObservation): unknown {
  const clone = structuredClone(observation) as GrokObservation;
  delete clone.source_revision;
  return clone;
}

function exactObservationJoin(
  accounts: ManagedAccount[],
  observation: CodexObservation,
): boolean {
  const counts = new Map(
    observation.accounts.map((account) => [account.accountKey, account.activeLeases]),
  );
  const rebuilt = buildCodexObservation(accounts, observation.observed_at_ms, counts);
  rebuilt.health = observation.health;
  rebuilt.dependency = structuredClone(observation.dependency);
  rebuilt.recommendation = structuredClone(observation.recommendation);
  rebuilt.notes = structuredClone(observation.notes);
  return canonical(withoutProvenance(rebuilt)) === canonical(withoutProvenance(observation));
}

function exactGrokObservationJoin(
  accounts: GrokStoredAccount[],
  observation: GrokObservation,
): boolean {
  const rebuilt = buildGrokObservation(accounts, observation.observed_at_ms);
  rebuilt.health = observation.health;
  rebuilt.dependency = structuredClone(observation.dependency);
  rebuilt.notes = structuredClone(observation.notes);
  return canonical(withoutGrokProvenance(rebuilt)) ===
    canonical(withoutGrokProvenance(observation));
}

function measurementGeneration(account: ManagedAccount): number | null {
  if (account.usage?.credential_generation !== undefined)
    return account.usage.credential_generation;
  // Generation one predates explicit measurement provenance but cannot have
  // followed a refresh or reauthentication, so the join is still exact.
  return account.credentials.generation === 1 ? 1 : null;
}

function sanitizeAccount(account: CodexAccountView): CodexAccountView {
  const authStatus = account.authStatus === 'ok'
    ? 'ok'
    : account.identityConflict
      ? 'identity-mismatch'
      : account.reloginRequired
        ? 'relogin-required'
        : 'unavailable';
  return {
    accountKey: account.accountKey,
    email: null,
    label: null,
    ordinal: null,
    enabled: account.enabled,
    present: account.present,
    authStatus,
    reloginRequired: account.reloginRequired,
    identityConflict: account.identityConflict,
    manuallyDisabled: account.manuallyDisabled,
    usageStatus: account.usageStatus,
    decisionGrade: account.decisionGrade,
    planType: null,
    limitReached: account.limitReached,
    resetCreditsAvailable: account.resetCreditsAvailable,
    resetCreditExpirations: structuredClone(account.resetCreditExpirations),
    measurementSource: account.measurementSource,
    measuredAtMs: account.measuredAtMs,
    lanes: account.lanes
      .filter((lane) => ['main', 'codex-spark', 'code-review'].includes(lane.id))
      .map((lane) => ({
        id: lane.id,
        title: lane.id === 'main'
          ? 'Main'
          : lane.id === 'codex-spark'
            ? 'Codex Spark'
            : 'Code Review',
        binding: lane.binding,
        windows: lane.windows.map((window) => ({
          role: window.role,
          label: window.label,
          windowSeconds: window.windowSeconds,
          usedPercent: window.usedPercent,
          remainingPercent: window.remainingPercent,
          resetsAt: window.resetsAt,
          resetAfterSeconds: window.resetAfterSeconds,
          limitName: null,
          meteredFeature: null,
        })),
      })),
    eligible: account.eligible,
    exclusions: [...account.exclusions],
    headroomPercent: account.headroomPercent,
    activeLeases: account.activeLeases,
    quotaBlockedUntilMs: structuredClone(account.quotaBlockedUntilMs),
    quotaBlockedAtMs: structuredClone(account.quotaBlockedAtMs),
    nextPollAt: account.nextPollAt,
    lastError: account.lastError === null
      ? null
      : { code: 'usage-unavailable', httpStatus: account.lastError.httpStatus, summary: null },
  };
}

function sanitizeGrokAccount(account: GrokAccountView): GrokAccountView {
  return {
    accountKey: account.accountKey,
    displayName: account.accountKey,
    ordinal: account.ordinal,
    alias: null,
    email: null,
    enabled: account.enabled,
    authStatus: account.authStatus,
    expiresAt: null,
    billingStatus: account.billingStatus,
    included: structuredClone(account.included),
    prepaid: structuredClone(account.prepaid),
    payg: structuredClone(account.payg),
    subscriptionTier: null,
    observedAtMs: account.observedAtMs,
    lastGoodAtMs: account.lastGoodAtMs,
    stale: account.stale,
    error: account.error === null ? null : {
      code: account.error.code,
      message: 'Grok usage is unavailable',
    },
  };
}

function aggregateSourceRevision(codex: number, grok: number): string {
  const left = BigInt(codex);
  const right = BigInt(grok);
  const sum = left + right;
  return ((sum * (sum + 1n)) / 2n + right + 1n).toString();
}

async function lockedProjection(
  paths: StatePaths,
): Promise<RoutingEvidenceProjection> {
  const pool = readPool(paths);
  const accounts = pool.accounts.filter((account) => account.provider === 'codex');
  const observation = readCodexObservation(paths);
  const grokState = await readGrokState(paths);
  const grokObservation = readGrokObservation(paths);
  if (observation === null || grokObservation === null)
    throw new RoutingEvidenceError('evidence_unavailable');
  if (!exactObservationJoin(accounts, observation))
    throw new RoutingEvidenceError('inconsistent_snapshot');
  if (!exactGrokObservationJoin(grokState.accounts, grokObservation))
    throw new RoutingEvidenceError('inconsistent_snapshot');

  const byKey = new Map(accounts.map((account) => [account.key, account]));
  const keys = new Set<string>();
  const generations: RoutingEvidenceProjection['account_generations'] = [];
  for (const view of observation.accounts) {
    const account = byKey.get(view.accountKey);
    if (account === undefined || keys.has(view.accountKey))
      throw new RoutingEvidenceError('inconsistent_snapshot');
    keys.add(view.accountKey);
    const measuredGeneration = measurementGeneration(account);
    if (view.eligible && measuredGeneration !== account.credentials.generation)
      throw new RoutingEvidenceError('generation_unavailable');
    generations.push({
      account_key: account.key,
      account_generation: account.ordinal,
      // Version one of the AgentUsage provider authority. OAuth credential
      // rotations are private revisions and do not replace this authority.
      provider_generation: CODEX_PROVIDER_AUTHORITY_GENERATION,
    });
  }
  if (keys.size !== accounts.length)
    throw new RoutingEvidenceError('inconsistent_snapshot');
  if (observation.recommendation !== null &&
      !keys.has(observation.recommendation.accountKey))
    throw new RoutingEvidenceError('inconsistent_snapshot');

  const grokByKey = new Map(grokState.accounts.map((account) => [account.accountKey, account]));
  for (const view of grokObservation.accounts) {
    const account = grokByKey.get(view.accountKey);
    if (account === undefined || keys.has(view.accountKey))
      throw new RoutingEvidenceError('inconsistent_snapshot');
    keys.add(view.accountKey);
    if (account.observation.lastGood !== null &&
      account.observation.lastGood.credentialFingerprint !==
        credentialFingerprint(account.credentials.accessToken)) {
      throw new RoutingEvidenceError('generation_unavailable');
    }
    generations.push({
      account_key: account.accountKey,
      account_generation: account.ordinal,
      provider_generation: GROK_PROVIDER_AUTHORITY_GENERATION,
    });
  }
  if (grokObservation.accounts.length !== grokState.accounts.length)
    throw new RoutingEvidenceError('inconsistent_snapshot');

  const codexRevision = observation.source_revision ?? observation.observed_at_ms;
  const grokRevision = grokObservation.source_revision ?? grokObservation.observed_at_ms;
  if (!Number.isSafeInteger(codexRevision) || codexRevision < 1 ||
      !Number.isSafeInteger(grokRevision) || grokRevision < 1)
    throw new RoutingEvidenceError('generation_unavailable');
  // The payload must be stable for one source revision. A wall-clock read time
  // would change the digest without advancing the revision and make consumers
  // correctly reject a same-revision conflict.
  const generatedAt = new Date(Math.max(
    observation.observed_at_ms,
    grokObservation.observed_at_ms,
  )).toISOString();
  const sanitized: CodexObservation = {
    schema_version: observation.schema_version,
    source_revision: codexRevision,
    observed_at_ms: observation.observed_at_ms,
    health: observation.health,
    dependency: null,
    recommendation: observation.recommendation !== null
      ? { accountKey: observation.recommendation.accountKey }
      : null,
    accounts: observation.accounts.map(sanitizeAccount),
    notes: [],
  };
  const sanitizedGrok: GrokObservation = {
    schema_version: grokObservation.schema_version,
    source_revision: grokRevision,
    observed_at_ms: grokObservation.observed_at_ms,
    health: grokObservation.health,
    dependency: null,
    accounts: grokObservation.accounts.map(sanitizeGrokAccount),
    notes: [],
  };
  return {
    schema_version: ROUTING_EVIDENCE_SCHEMA_VERSION,
    source_revision: aggregateSourceRevision(codexRevision, grokRevision),
    provider_source_revisions: { codex: codexRevision, grok: grokRevision },
    generated_at: generatedAt,
    usage: {
      schema_version: 1,
      generated_at: generatedAt,
      claude: null,
      codex: sanitized,
      grok: sanitizedGrok,
    },
    account_generations: generations.sort((left, right) =>
      left.account_key.localeCompare(right.account_key)),
  };
}

/**
 * Reads one provider/account-consistent projection. It never refreshes a
 * provider or mutates account state. Lock contention refuses instead of
 * returning a potentially mixed snapshot.
 */
export async function readRoutingEvidence(
  paths: StatePaths,
  nowMs = Date.now(),
): Promise<RoutingEvidenceProjection> {
  return withRoutingEvidenceSnapshot(paths, evidence => evidence, nowMs);
}

/** Owner-internal callback runs while all observation/account locks are held. */
export async function withRoutingEvidenceSnapshot<T>(
  paths: StatePaths,
  inspect: (evidence: RoutingEvidenceProjection) => T | Promise<T>,
  nowMs = Date.now(),
): Promise<T> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RoutingEvidenceError('inconsistent_snapshot');
  if (!existsSync(paths.codexRefreshLock) || !existsSync(paths.grokRefreshLock) ||
      !existsSync(accountLock(paths)) || !existsSync(grokAccountLock(paths)))
    throw new RoutingEvidenceError('evidence_unavailable');
  let callbackError: unknown;
  try {
    return await withLock(
      paths.codexRefreshLock,
      () => withLock(
        paths.grokRefreshLock,
        () => withLock(
          accountLock(paths),
          () => withLock(grokAccountLock(paths), async () => {
            const evidence = await lockedProjection(paths);
            try { return await inspect(evidence); } catch (error) { callbackError = error; throw error; }
          }, 0),
          0,
        ),
        0,
      ),
      0,
    );
  } catch (error) {
    if (error === callbackError) throw error;
    if (error instanceof RoutingEvidenceError) throw error;
    if (error instanceof AccountError && error.code === 'busy')
      throw new RoutingEvidenceError('snapshot_busy');
    throw new RoutingEvidenceError('evidence_unavailable');
  }
}
