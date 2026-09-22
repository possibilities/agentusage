import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

function missingWorkingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * OpenTUI opens the terminal through a path resolved from `process.cwd()`.
 * A shell whose directory was removed makes that throw before the viewer
 * paints. Move to a directory that still exists; the TUI does not use the
 * working directory for observations.
 */
export function ensureWorkingDirectory(): void {
  try {
    process.cwd();
    return;
  } catch (error) {
    if (!missingWorkingDirectory(error)) throw error;
  }
  for (const candidate of [homedir(), tmpdir(), "/"]) {
    if (candidate.length === 0 || !candidate.startsWith("/")) continue;
    try {
      if (!existsSync(candidate)) continue;
      process.chdir(candidate);
      process.cwd();
      return;
    } catch {
      // Try the next absolute directory.
    }
  }
  throw new Error("agentusage: the working directory no longer exists");
}
