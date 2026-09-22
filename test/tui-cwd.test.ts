import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TUI working directory", () => {
  test("leaves a deleted working directory before the viewer opens a tty", () => {
    const root = mkdtempSync(join(tmpdir(), "agentusage-cwd-"));
    const script = `
      import { rmSync } from "node:fs";
      import { ensureWorkingDirectory } from ${JSON.stringify(join(import.meta.dir, "../src/tui/cwd.ts"))};
      const dir = process.argv[1];
      process.chdir(dir);
      rmSync(dir, { recursive: true });
      let missing = false;
      try { process.cwd(); } catch (error) {
        missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      }
      if (!missing) throw new Error("expected a missing working directory");
      ensureWorkingDirectory();
      const cwd = process.cwd();
      if (cwd === dir) throw new Error("still in the deleted directory");
      console.log(cwd);
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", script, root],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(root, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain("uv_cwd");
    expect(result.stdout.toString().trim().startsWith("/")).toBe(true);
  });
});
