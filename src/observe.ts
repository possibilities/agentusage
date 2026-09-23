import { DEVIN_OBSERVATION_FRESHNESS_CEILING_MS, OBSERVATION_FRESHNESS_CEILING_MS, SUBPROCESS_TIMEOUT_MS } from "./constants.ts";
import { observeClaude } from "./claude/observe.ts";
import { type Observation, validateObservation } from "./claude/types.ts";
import { observeCodex } from "./codex/observe.ts";
import { type CodexObservation, validateCodexObservation } from "./codex/types.ts";
import { observeGrok } from "./grok/observe.ts";
import { type GrokObservation, validateGrokObservation } from "./grok/types.ts";
import { observeGrokBot } from "./grok-bot/observe.ts";
import { type GrokBotObservation, validateGrokBotObservation } from "./grok-bot/types.ts";
import { observeDevin } from "./devin/observe.ts";
import { type DevinObservation, validateDevinObservation } from "./devin/types.ts";
import type { StatePaths } from "./paths.ts";
import { providerSafeRefresh, type RefreshResult } from "./refresh.ts";
import { readSidecar, writeSidecar } from "./sidecar.ts";

export function readClaudeObservation(paths: StatePaths): Observation | null {
  return readSidecar(paths.claudeObservation, validateObservation).value;
}

export function readCodexObservation(paths: StatePaths): CodexObservation | null {
  return readSidecar(paths.codexObservation, validateCodexObservation).value;
}

export function readGrokObservation(paths: StatePaths): GrokObservation | null {
  return readSidecar(paths.grokObservation, validateGrokObservation).value;
}

export function readGrokBotObservation(paths: StatePaths): GrokBotObservation | null {
  return readSidecar(paths.grokBotObservation, validateGrokBotObservation).value;
}

export function readDevinObservation(paths: StatePaths): DevinObservation | null {
  return readSidecar(paths.devinObservation, validateDevinObservation).value;
}

export function nextCodexSourceRevision(
  previous: CodexObservation | null,
  observedAtMs: number,
): number {
  const prior = previous?.source_revision ?? previous?.observed_at_ms ?? 0;
  const revision = Math.max(observedAtMs, prior + 1);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('Codex observation source revision exhausted');
  return revision;
}

export function nextGrokBotSourceRevision(
  previous: GrokBotObservation | null,
  observedAtMs: number,
): number {
  const prior = previous?.source_revision ?? previous?.observed_at_ms ?? 0;
  const revision = Math.max(observedAtMs, prior + 1);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Grok Bot observation source revision exhausted");
  return revision;
}

export function nextDevinSourceRevision(
  previous: DevinObservation | null,
  observedAtMs: number,
): number {
  const prior = previous?.source_revision ?? previous?.observed_at_ms ?? 0;
  const revision = Math.max(observedAtMs, prior + 1);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Devin observation source revision exhausted");
  return revision;
}

export function nextGrokSourceRevision(
  previous: GrokObservation | null,
  observedAtMs: number,
): number {
  const prior = previous?.source_revision ?? previous?.observed_at_ms ?? 0;
  const revision = Math.max(observedAtMs, prior + 1);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('Grok observation source revision exhausted');
  return revision;
}

export interface RefreshOverrides {
  /** Values fresher than this short-circuit; 0 forces a provider call. */
  freshWithinMs?: number;
  env?: Record<string, string | undefined>;
}

export async function refreshClaudeObservation(
  paths: StatePaths,
  overrides: RefreshOverrides = {},
): Promise<RefreshResult<Observation>> {
  return providerSafeRefresh<Observation>({
    lockPath: paths.claudeRefreshLock,
    read: () => readClaudeObservation(paths),
    observedAtMs: (value) => value.observed_at_ms,
    freshWithinMs: overrides.freshWithinMs ?? OBSERVATION_FRESHNESS_CEILING_MS,
    produce: () => observeClaude({ ...(overrides.env ?? process.env), AGENTUSAGE_STATE_ROOT: paths.stateRoot }),
    write: (value) => writeSidecar(paths.claudeObservation, value),
    waitMs: SUBPROCESS_TIMEOUT_MS + 1_000,
  });
}

export async function refreshCodexObservation(
  paths: StatePaths,
  overrides: RefreshOverrides & { noFetch?: boolean } = {},
): Promise<RefreshResult<CodexObservation>> {
  return providerSafeRefresh<CodexObservation>({
    lockPath: paths.codexRefreshLock,
    read: () => readCodexObservation(paths),
    observedAtMs: (value) => value.observed_at_ms,
    freshWithinMs: overrides.freshWithinMs ?? OBSERVATION_FRESHNESS_CEILING_MS,
    produce: () => observeCodex({
      env: { ...(overrides.env ?? process.env), AGENTUSAGE_STATE_ROOT: paths.stateRoot },
      noFetch: overrides.noFetch,
      force: (overrides.freshWithinMs ?? OBSERVATION_FRESHNESS_CEILING_MS) === 0,
    }),
    write: (value) => {
      value.source_revision = nextCodexSourceRevision(
        readCodexObservation(paths),
        value.observed_at_ms,
      );
      writeSidecar(paths.codexObservation, value);
    },
    waitMs: 61_000,
  });
}

export async function refreshGrokObservation(
  paths: StatePaths,
  overrides: RefreshOverrides & { providerRefresh?: boolean; account?: string } = {},
): Promise<RefreshResult<GrokObservation>> {
  return providerSafeRefresh<GrokObservation>({
    lockPath: paths.grokRefreshLock,
    read: () => readGrokObservation(paths),
    observedAtMs: (value) => value.observed_at_ms,
    freshWithinMs: overrides.freshWithinMs ?? OBSERVATION_FRESHNESS_CEILING_MS,
    produce: () =>
      observeGrok({
        env: { ...(overrides.env ?? process.env), AGENTUSAGE_STATE_ROOT: paths.stateRoot },
        refresh: overrides.providerRefresh,
        account: overrides.account,
      }),
    write: (value) => {
      value.source_revision = nextGrokSourceRevision(
        readGrokObservation(paths),
        value.observed_at_ms,
      );
      writeSidecar(paths.grokObservation, value);
    },
    waitMs: 61_000,
  });
}

export async function refreshGrokBotObservation(
  paths: StatePaths,
  overrides: RefreshOverrides = {},
): Promise<RefreshResult<GrokBotObservation>> {
  return providerSafeRefresh<GrokBotObservation>({
    lockPath: paths.grokBotRefreshLock,
    read: () => readGrokBotObservation(paths),
    observedAtMs: (value) => value.observed_at_ms,
    freshWithinMs: overrides.freshWithinMs ?? OBSERVATION_FRESHNESS_CEILING_MS,
    produce: () =>
      observeGrokBot({
        env: overrides.env ?? process.env,
        previous: readGrokBotObservation(paths),
      }),
    write: (value) => {
      value.source_revision = nextGrokBotSourceRevision(
        readGrokBotObservation(paths),
        value.observed_at_ms,
      );
      writeSidecar(paths.grokBotObservation, value);
    },
    waitMs: SUBPROCESS_TIMEOUT_MS + 1_000,
  });
}

export async function refreshDevinObservation(
  paths: StatePaths,
  overrides: RefreshOverrides = {},
): Promise<RefreshResult<DevinObservation>> {
  return providerSafeRefresh<DevinObservation>({
    lockPath: paths.devinRefreshLock,
    read: () => readDevinObservation(paths),
    observedAtMs: (value) => value.observed_at_ms,
    freshWithinMs: overrides.freshWithinMs ?? DEVIN_OBSERVATION_FRESHNESS_CEILING_MS,
    produce: () =>
      observeDevin({
        env: overrides.env ?? process.env,
        previous: readDevinObservation(paths),
      }),
    write: (value) => {
      value.source_revision = nextDevinSourceRevision(
        readDevinObservation(paths),
        value.observed_at_ms,
      );
      writeSidecar(paths.devinObservation, value);
    },
    waitMs: 16_000,
  });
}
