import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sidecars are replace-in-place JSON files: readers poll the stable path (an
 * atomic rename changes the inode, so watching an fd would go blind — keeper
 * ADR 0097), writers stage a 0600 temp file in the same directory.
 */
export function writeSidecar(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The stray temp file is harmless; the rename error is the real fault.
    }
    throw error;
  }
}

export interface SidecarRead<T> {
  value: T | null;
  state: "ok" | "absent" | "malformed";
}

export function readSidecar<T>(path: string, validate: (value: unknown) => T | null): SidecarRead<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { value: null, state: code === "ENOENT" ? "absent" : "malformed" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = validate(parsed);
    return value === null ? { value: null, state: "malformed" } : { value, state: "ok" };
  } catch {
    return { value: null, state: "malformed" };
  }
}
