import { OBSERVATION_FRESHNESS_CEILING_MS, SUBPROCESS_TIMEOUT_MS } from "./constants.ts";
import { observeClaude } from "./claude/observe.ts";
import { type Observation, validateObservation } from "./claude/types.ts";
import { observeCodex } from "./codex/observe.ts";
import { type CodexObservation, validateCodexObservation } from "./codex/types.ts";
import type { StatePaths } from "./paths.ts";
import { providerSafeRefresh, type RefreshResult } from "./refresh.ts";
import { readSidecar, writeSidecar } from "./sidecar.ts";

export function readClaudeObservation(paths: StatePaths): Observation | null {
  return readSidecar(paths.claudeObservation, validateObservation).value;
}

export function readCodexObservation(paths: StatePaths): CodexObservation | null {
  return readSidecar(paths.codexObservation, validateCodexObservation).value;
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
    produce: () => observeClaude(overrides.env ?? process.env),
    write: (value) => writeSidecar(paths.claudeObservation, value),
    waitMs: SUBPROCESS_TIMEOUT_MS + 1_000,
    lockStaleMs: SUBPROCESS_TIMEOUT_MS + 5_000,
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
    produce: () => observeCodex({ env: overrides.env ?? process.env, noFetch: overrides.noFetch }),
    write: (value) => writeSidecar(paths.codexObservation, value),
    waitMs: 61_000,
    lockStaleMs: 65_000,
  });
}
