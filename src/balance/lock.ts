import { closeSync, constants, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface PathLockOptions {
  /** Locks older than this are presumed abandoned and stolen. */
  staleMs: number;
  /** Bounded busy-wait before proceeding without the lock. */
  waitMs: number;
}

/**
 * Best-effort advisory lock via O_EXCL lockfile. The ledger write it guards
 * is itself atomic, so proceeding after the bounded wait risks only a lost
 * reservation increment — never a torn file.
 */
export function acquirePathLock(lockPath: string, options: PathLockOptions): boolean {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > options.staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return false;
      const wakeAt = Date.now() + 10;
      while (Date.now() < wakeAt) {
        // Busy-wait a beat; contention here is rare and brief.
      }
    }
  }
}

export function releasePathLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}
