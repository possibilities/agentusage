#!/usr/bin/env bun
import {
  OBSERVE_INTERVAL_MS,
  OBSERVE_JITTER_MS,
  WEEKLY_RESET_WAKE_SLACK_MS,
} from './constants.ts';
import {
  type NormalizedWindow,
  type Observation,
  WEEK_WINDOW,
} from './claude/types.ts';
import {
  readClaudeObservation,
  readCodexObservation,
  readGrokObservation,
  refreshClaudeObservation,
  refreshCodexObservation,
  refreshGrokObservation,
} from './observe.ts';
import { statePaths, type StatePaths } from './paths.ts';
import { readyEndpoint, startProxy } from './service/proxy.ts';
import { VERSION } from './version.ts';

/** One launchd-supervised process owns observations, credential refresh and native request proxying. */

function log(scope: string, message: string): void {
  console.log(`${new Date().toISOString()} [${scope}] ${message}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One-shot early wake shortly after an exhausted weekly window resets, so the
 * reset is observed promptly instead of up to a full interval late.
 */
export function weeklyResetWakeDelayMs(
  observation: Observation,
  nowMs: number,
): number | null {
  let best: number | null = null;
  const scan = (windows: readonly NormalizedWindow[]): void => {
    for (const window of windows) {
      if (
        window.key !== WEEK_WINDOW ||
        window.utilization < 1 ||
        window.resetsAt === null
      )
        continue;
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs)) continue;
      const delay = resetMs + WEEKLY_RESET_WAKE_SLACK_MS - nowMs;
      if (delay > 0 && (best === null || delay < best)) best = delay;
    }
  };
  for (const route of observation.routes) scan(route.windows);
  for (const measurement of Object.values(
    observation.account_measurements ?? {},
  ))
    scan(measurement.windows);
  return best;
}

async function claudeLoop(
  paths: StatePaths,
  signal: AbortSignal,
  env: Record<string, string | undefined>,
): Promise<void> {
  let resetTriggered = false;
  while (!signal.aborted) {
    let observation: Observation | null = null;
    try {
      const started = Date.now();
      const result = await refreshClaudeObservation(paths, {
        freshWithinMs: 60_000,
        env,
      });
      observation = result.value;
      log(
        'claude',
        `${result.outcome} health=${observation?.health ?? 'none'} routes=${observation?.routes.length ?? 0} issues=${
          observation === null
            ? 0
            : Object.keys(observation.account_issues).length
        } (${Date.now() - started}ms)`,
      );
    } catch (error) {
      log('claude', `cycle threw (non-fatal): ${String(error)}`);
    }
    if (signal.aborted) return;
    const ordinaryDelayMs =
      OBSERVE_INTERVAL_MS + Math.random() * OBSERVE_JITTER_MS;
    let delayMs = ordinaryDelayMs;
    let nextCycleResetTriggered = false;
    if (!resetTriggered && observation !== null) {
      const resetDelayMs = weeklyResetWakeDelayMs(observation, Date.now());
      if (resetDelayMs !== null && resetDelayMs < ordinaryDelayMs) {
        delayMs = resetDelayMs;
        nextCycleResetTriggered = true;
        log(
          'claude',
          `weekly reset wake in ${Math.round(resetDelayMs / 1000)}s`,
        );
      }
    }
    resetTriggered = nextCycleResetTriggered;
    await sleep(delayMs, signal);
  }
}

async function codexLoop(
  paths: StatePaths,
  signal: AbortSignal,
  env: Record<string, string | undefined>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const started = Date.now();
      const result = await refreshCodexObservation(paths, {
        freshWithinMs: 60_000,
        env,
      });
      const observation = result.value;
      log(
        'codex',
        `${result.outcome} health=${observation?.health ?? 'none'} accounts=${observation?.accounts.length ?? 0} (${
          Date.now() - started
        }ms)`,
      );
    } catch (error) {
      log('codex', `cycle threw (non-fatal): ${String(error)}`);
    }
    if (signal.aborted) return;
    await sleep(
      OBSERVE_INTERVAL_MS + Math.random() * OBSERVE_JITTER_MS,
      signal,
    );
  }
}

async function grokLoop(
  paths: StatePaths,
  signal: AbortSignal,
  env: Record<string, string | undefined>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const started = Date.now();
      // grok-swap owns network pacing/backoff and its durable last-good data;
      // the daemon only mirrors `observe` into AgentUsage's sidecar.
      const result = await refreshGrokObservation(paths, {
        freshWithinMs: 60_000,
        env,
      });
      const observation = result.value;
      log(
        'grok',
        `${result.outcome} health=${observation?.health ?? 'none'} accounts=${observation?.accounts.length ?? 0} (${
          Date.now() - started
        }ms)`,
      );
    } catch (error) {
      log('grok', `cycle threw (non-fatal): ${String(error)}`);
    }
    if (signal.aborted) return;
    await sleep(
      OBSERVE_INTERVAL_MS + Math.random() * OBSERVE_JITTER_MS,
      signal,
    );
  }
}

export async function daemonRun(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const paths = statePaths(env);
  const controller = new AbortController();
  const stop = (signalName: string): void => {
    log('daemon', `received ${signalName}; shutting down`);
    controller.abort();
  };
  const term = () => stop('SIGTERM'),
    interrupt = () => stop('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  log(
    'daemon',
    `agentusage observer ${VERSION} starting (state ${paths.stateRoot})`,
  );
  const proxy = await startProxy(paths, { env });
  const drain = (): void => {
    void proxy.stop().catch(() => {});
  };
  controller.signal.addEventListener('abort', drain, { once: true });
  try {
    await Promise.all([
      claudeLoop(paths, controller.signal, env),
      codexLoop(paths, controller.signal, env),
      grokLoop(paths, controller.signal, env),
    ]);
  } finally {
    await proxy.stop();
    controller.signal.removeEventListener('abort', drain);
    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
  }
  log('daemon', 'stopped');
}

/** Liveness probe for the machine's verify step: both sidecars written recently. */
export async function daemonStatus(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const paths = statePaths(env);
  const claude = readClaudeObservation(paths);
  const codex = readCodexObservation(paths);
  const grok = readGrokObservation(paths);
  if (claude === null && codex === null && grok === null) {
    console.log('absent');
    return 1;
  }
  const nowMs = Date.now();
  const staleCeilingMs = 2 * (OBSERVE_INTERVAL_MS + OBSERVE_JITTER_MS) + 60_000;
  const claudeFresh =
    claude !== null && nowMs - claude.observed_at_ms <= staleCeilingMs;
  const codexFresh =
    codex !== null && nowMs - codex.observed_at_ms <= staleCeilingMs;
  const grokFresh =
    grok !== null && nowMs - grok.observed_at_ms <= staleCeilingMs;
  let proxyReady = false;
  try {
    await readyEndpoint(paths);
    proxyReady = true;
  } catch {}
  if (proxyReady && claudeFresh && codexFresh && grokFresh) {
    console.log('ready');
    return 0;
  }
  console.log('stale');
  return 1;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'run';
  if (mode === 'status') {
    void daemonStatus().then((code) => process.exit(code));
  } else if (mode === 'run') {
    daemonRun().catch((error) => {
      log('daemon', `fatal: ${String(error)}`);
      process.exit(1);
    });
  } else {
    console.error(
      `agentusage daemon: unknown mode ${mode} (expected run|status)`,
    );
    process.exit(2);
  }
}
