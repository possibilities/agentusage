#!/usr/bin/env bun
import {
  MAX_OUTPUT_BYTES,
  OBSERVE_INTERVAL_MS,
  OBSERVE_JITTER_MS,
  RECOVERY_MIN_INTERVAL_MS,
  RECOVERY_TIMEOUT_MS,
  WEEKLY_RESET_WAKE_SLACK_MS,
} from "./constants.ts";
import { type NormalizedWindow, type Observation, WEEK_WINDOW, slotForRouteId } from "./claude/types.ts";
import { readClaudeObservation, readCodexObservation, refreshClaudeObservation, refreshCodexObservation } from "./observe.ts";
import { cswapArgv, statePaths, type StatePaths } from "./paths.ts";
import { runBounded } from "./proc.ts";
import { VERSION } from "./version.ts";

/**
 * agentusaged — both provider observation loops in one launchd-supervised
 * process. Claude follows keeper's cadence (3 min + jitter, weekly-reset
 * early wake, one due recovery per cycle); codex polls codex-swap on the same
 * cadence while codex-swap's own poll plans pace real network fetches.
 */

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
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One-shot early wake shortly after an exhausted weekly window resets, so the
 * reset is observed promptly instead of up to a full interval late.
 */
export function weeklyResetWakeDelayMs(observation: Observation, nowMs: number): number | null {
  let best: number | null = null;
  const scan = (windows: readonly NormalizedWindow[]): void => {
    for (const window of windows) {
      if (window.key !== WEEK_WINDOW || window.utilization < 1 || window.resetsAt === null) continue;
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs)) continue;
      const delay = resetMs + WEEKLY_RESET_WAKE_SLACK_MS - nowMs;
      if (delay > 0 && (best === null || delay < best)) best = delay;
    }
  };
  for (const route of observation.routes) scan(route.windows);
  for (const measurement of Object.values(observation.account_measurements ?? {})) scan(measurement.windows);
  return best;
}

const recoveryAttempts = new Map<number, number>();

/** At most one due `cswap recover` per cycle; failures are logged, never fatal. */
async function recoveryPass(observation: Observation, env: Record<string, string | undefined>): Promise<void> {
  const nowMs = Date.now();
  for (const [id, issue] of Object.entries(observation.account_issues)) {
    if (issue !== "token-expired") continue;
    const slot = slotForRouteId(id);
    if (slot === null) continue;
    const last = recoveryAttempts.get(slot);
    if (last !== undefined && nowMs - last < RECOVERY_MIN_INTERVAL_MS) continue;
    recoveryAttempts.set(slot, nowMs);
    log("claude", `attempting token recovery for ${id}`);
    const run = await runBounded([...cswapArgv(env), "recover", String(slot), "--json"], {
      timeoutMs: RECOVERY_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (run.ok) {
      log("claude", `recovery for ${id} succeeded`);
    } else {
      const detail = run.error ?? `exit ${run.code}`;
      const stderr = run.stderr.trim().split("\n").at(-1) ?? "";
      log("claude", `recovery for ${id} failed (${detail}${stderr ? `: ${stderr.slice(0, 160)}` : ""})`);
    }
    return;
  }
}

async function claudeLoop(paths: StatePaths, signal: AbortSignal, env: Record<string, string | undefined>): Promise<void> {
  let resetTriggered = false;
  while (!signal.aborted) {
    let observation: Observation | null = null;
    try {
      const started = Date.now();
      const result = await refreshClaudeObservation(paths, { freshWithinMs: 60_000, env });
      observation = result.value;
      log(
        "claude",
        `${result.outcome} health=${observation?.health ?? "none"} routes=${observation?.routes.length ?? 0} issues=${
          observation === null ? 0 : Object.keys(observation.account_issues).length
        } (${Date.now() - started}ms)`,
      );
      if (observation !== null && observation.health === "ok") await recoveryPass(observation, env);
    } catch (error) {
      log("claude", `cycle threw (non-fatal): ${String(error)}`);
    }
    if (signal.aborted) return;
    const ordinaryDelayMs = OBSERVE_INTERVAL_MS + Math.random() * OBSERVE_JITTER_MS;
    let delayMs = ordinaryDelayMs;
    let nextCycleResetTriggered = false;
    if (!resetTriggered && observation !== null) {
      const resetDelayMs = weeklyResetWakeDelayMs(observation, Date.now());
      if (resetDelayMs !== null && resetDelayMs < ordinaryDelayMs) {
        delayMs = resetDelayMs;
        nextCycleResetTriggered = true;
        log("claude", `weekly reset wake in ${Math.round(resetDelayMs / 1000)}s`);
      }
    }
    resetTriggered = nextCycleResetTriggered;
    await sleep(delayMs, signal);
  }
}

async function codexLoop(paths: StatePaths, signal: AbortSignal, env: Record<string, string | undefined>): Promise<void> {
  while (!signal.aborted) {
    try {
      const started = Date.now();
      const result = await refreshCodexObservation(paths, { freshWithinMs: 60_000, env });
      const observation = result.value;
      log(
        "codex",
        `${result.outcome} health=${observation?.health ?? "none"} accounts=${observation?.accounts.length ?? 0} (${
          Date.now() - started
        }ms)`,
      );
    } catch (error) {
      log("codex", `cycle threw (non-fatal): ${String(error)}`);
    }
    if (signal.aborted) return;
    await sleep(OBSERVE_INTERVAL_MS + Math.random() * OBSERVE_JITTER_MS, signal);
  }
}

export async function daemonRun(env: Record<string, string | undefined> = process.env): Promise<void> {
  const paths = statePaths(env);
  const controller = new AbortController();
  const stop = (signalName: string): void => {
    log("daemon", `received ${signalName}; shutting down`);
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  log("daemon", `agentusaged ${VERSION} starting (state ${paths.stateRoot})`);
  await Promise.all([
    claudeLoop(paths, controller.signal, env),
    codexLoop(paths, controller.signal, env),
  ]);
  log("daemon", "stopped");
}

/** Liveness probe for funk's verify step: both sidecars written recently. */
export function daemonStatus(env: Record<string, string | undefined> = process.env): number {
  const paths = statePaths(env);
  const claude = readClaudeObservation(paths);
  const codex = readCodexObservation(paths);
  if (claude === null && codex === null) {
    console.log("absent");
    return 1;
  }
  const nowMs = Date.now();
  const staleCeilingMs = 2 * (OBSERVE_INTERVAL_MS + OBSERVE_JITTER_MS) + 60_000;
  const claudeFresh = claude !== null && nowMs - claude.observed_at_ms <= staleCeilingMs;
  const codexFresh = codex !== null && nowMs - codex.observed_at_ms <= staleCeilingMs;
  if (claudeFresh && codexFresh) {
    console.log("ready");
    return 0;
  }
  console.log("stale");
  return 1;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "run";
  if (mode === "status") {
    process.exit(daemonStatus());
  } else if (mode === "run") {
    daemonRun().catch((error) => {
      log("daemon", `fatal: ${String(error)}`);
      process.exit(1);
    });
  } else {
    console.error(`agentusaged: unknown mode ${mode} (expected run|status)`);
    process.exit(2);
  }
}
