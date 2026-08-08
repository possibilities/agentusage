import { openSync, closeSync, constants, rmSync, statSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Provider-safe refresh: at most one provider subprocess per sidecar at a
 * time. The lock is non-blocking — a contended caller re-reads the sidecar
 * for a bounded window instead of stacking a second provider call (keeper's
 * `runProviderSafeRefresh` contract).
 */

export type RefreshOutcome = "already-fresh" | "refreshed" | "peer-published" | "contended" | "provider-failed";

export interface RefreshResult<T> {
  outcome: RefreshOutcome;
  value: T | null;
}

export interface RefreshOptions<T> {
  lockPath: string;
  /** Read the current sidecar; null when absent/malformed. */
  read: () => T | null;
  /** Epoch ms the value was observed; null disables freshness short-circuit. */
  observedAtMs: (value: T) => number;
  /** A value at least this fresh short-circuits to already-fresh. */
  freshWithinMs: number;
  /** Run the provider and build the observation (may report failure inside). */
  produce: () => Promise<T>;
  write: (value: T) => void;
  /** How long a contended caller waits for a peer to publish. */
  waitMs: number;
  /** Locks older than this are presumed abandoned and stolen. */
  lockStaleMs: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function tryAcquireLock(lockPath: string, lockStaleMs: number, nowMs: number): boolean {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, `${process.pid} ${nowMs}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        const stat = statSync(lockPath);
        if (nowMs - stat.mtimeMs <= lockStaleMs) return false;
        rmSync(lockPath, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function providerSafeRefresh<T>(options: RefreshOptions<T>): Promise<RefreshResult<T>> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  const initial = options.read();
  if (initial !== null && nowMs() - options.observedAtMs(initial) <= options.freshWithinMs) {
    return { outcome: "already-fresh", value: initial };
  }

  if (tryAcquireLock(options.lockPath, options.lockStaleMs, nowMs())) {
    try {
      let produced: T;
      try {
        produced = await options.produce();
      } catch {
        return { outcome: "provider-failed", value: initial };
      }
      options.write(produced);
      return { outcome: "refreshed", value: produced };
    } finally {
      releaseLock(options.lockPath);
    }
  }

  const deadline = nowMs() + options.waitMs;
  const baseline = initial === null ? null : options.observedAtMs(initial);
  while (nowMs() < deadline) {
    await sleep(250);
    const current = options.read();
    if (current === null) continue;
    const observed = options.observedAtMs(current);
    const fresh = nowMs() - observed <= options.freshWithinMs;
    const advanced = baseline === null || observed > baseline;
    if (fresh || advanced) return { outcome: "peer-published", value: current };
  }
  return { outcome: "contended", value: options.read() ?? initial };
}
