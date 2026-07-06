#!/usr/bin/env bun

/**
 * End-to-end conformance runner for the Bun scrape CLI — `bun run conformance`.
 *
 * Drives the REAL bun CLI (`src/scrape-cli.ts`) through the bun fake TUI
 * (`tests/fake-tui.ts`) for every corpus case plus the CLI-level forks the parse
 * layer can't reach — the no-bar auth probe, a mount-delay ready-wait race, and a
 * stubborn-child reaping case — then absorbs the subprocess contract cases from
 * the old pytest suite (writes-no-state, argv-error exits). For each it asserts
 * the one-line stdout contract deep-equals the committed golden, the exact reset
 * strings, and the exit code.
 *
 * This is a STANDALONE `bun run` script, NOT a `bun test` module, on purpose: it
 * spawns subprocesses and captures their stdout through temp files, staying
 * clear of Bun#24690 (subprocess pipes read back empty inside the test runner).
 * The tmux-free parse half lives in `src/parse-conformance.test.ts`.
 *
 * Skip discipline: the bun scrape driver needs tmux; a tmux-absent host reports a
 * reasoned skip and exits 0, but `AGENTUSAGE_REQUIRE_CONFORMANCE=1` promotes that
 * skip to a hard failure so a designated run can't be vacuously green (the
 * successor to REQUIRE_PARITY).
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_CLI = join(REPO_ROOT, "src", "scrape-cli.ts");
const FAKE_TUI = join(REPO_ROOT, "tests", "fake-tui.ts");
const CORPUS_DIR = join(REPO_ROOT, "tests", "fixtures", "corpus");
const BUN = process.execPath;

const REQUIRE = process.env.AGENTUSAGE_REQUIRE_CONFORMANCE === "1";

// The fake must outlive the whole tmux-driven scrape; hold it well past the
// driver's worst-case sentinel budget but under a genuine wedge's self-exit.
const FAKE_MAX_SECONDS = "90";

const OK_NO_SUB = { schema_version: 1, status: "ok", no_subscription: true };
const OK_SIGNED_OUT = { schema_version: 1, status: "ok", signed_out: true };

// ---------- process driving -------------------------------------------------

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOpts {
  caseDir?: string;
  now?: string;
  tz?: string;
  home?: string;
  extraEnv?: Record<string, string>;
}

let scratch = "";

/**
 * Invoke the bun CLI with a pinned clock/env, capturing stdout via a temp FILE
 * (never a pipe). A `caseDir` selects the fake TUI and appends `--command`;
 * argv-error cases omit it so the CLI fails on argv before any spawn.
 */
async function runBunCli(argv: string[], opts: RunOpts): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  if (opts.caseDir) {
    env.AGENTUSAGE_FAKE_CASE = opts.caseDir;
  }
  if (opts.now) {
    env.AGENTUSAGE_NOW = opts.now;
  }
  if (opts.tz) {
    env.TZ = opts.tz;
  }
  if (opts.home) {
    env.HOME = opts.home;
  }
  env.AGENTUSAGE_FAKE_MAX_SECONDS = FAKE_MAX_SECONDS;
  // Never let the promotion gate leak into the child's own environment.
  delete env.AGENTUSAGE_REQUIRE_CONFORMANCE;
  delete env.AGENTUSAGE_REQUIRE_PARITY;
  if (opts.extraEnv) {
    Object.assign(env, opts.extraEnv);
  }

  const outPath = join(scratch, `out-${crypto.randomUUID()}`);
  const outFd = openSync(outPath, "w");
  const cmd = opts.caseDir
    ? [BUN, SRC_CLI, ...argv, "--command", FAKE_TUI]
    : [BUN, SRC_CLI, ...argv];
  try {
    const proc = Bun.spawn(cmd, {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: outFd,
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    closeSync(outFd);
    const stdout = readFileSync(outPath, "utf8");
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(outPath, { force: true });
  }
}

// ---------- assertions ------------------------------------------------------

class AssertionError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new AssertionError(msg);
  }
}

/** Assert stdout is exactly one JSON object + trailing newline; return it. */
function parseOneJsonLine(stdout: string): Record<string, unknown> {
  assert(stdout.length > 0, "expected one JSON object on stdout, got nothing");
  assert(
    stdout.endsWith("\n"),
    `stdout must end with a newline: ${JSON.stringify(stdout)}`,
  );
  const body = stdout.slice(0, -1);
  assert(
    !body.includes("\n"),
    `expected exactly one stdout line, got: ${JSON.stringify(stdout)}`,
  );
  return JSON.parse(body) as Record<string, unknown>;
}

function resetTimes(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      out[k] = (v as Record<string, unknown>).resets_at;
    }
  }
  return out;
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  assert(
    Bun.deepEquals(actual, expected, true),
    `${label}\n  actual  =${JSON.stringify(actual)}\n  expected=${JSON.stringify(expected)}`,
  );
}

function assertContract(
  res: CliResult,
  expected: Record<string, unknown>,
  expectedExit: number,
): void {
  const json = parseOneJsonLine(res.stdout);
  assertDeepEqual(
    json,
    expected,
    `payload diverged from the contract\n  stderr:\n${res.stderr}`,
  );
  assertDeepEqual(
    resetTimes(json),
    resetTimes(expected),
    "reset strings diverged",
  );
  assert(
    res.exitCode === expectedExit,
    `exit ${res.exitCode} != ${expectedExit}\n  stderr:\n${res.stderr}`,
  );
}

// ---------- case cloning ----------------------------------------------------

/** Clone a corpus case's transcript into `dest` with case.json overrides. */
function makeCase(
  dest: string,
  baseName: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const base = join(CORPUS_DIR, baseName);
  const meta = JSON.parse(readFileSync(join(base, "case.json"), "utf8"));
  Object.assign(meta, overrides);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "case.json"), JSON.stringify(meta));
  copyFileSync(join(base, "transcript.ansi"), join(dest, "transcript.ansi"));
  return meta;
}

function sandboxHome(name: string): string {
  const home = join(scratch, `home-${name}-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "ESRCH") {
      return false;
    }
    return true; // EPERM etc. — it exists but we can't signal it
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- runner scaffold -------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${label}\n`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${label}: ${msg}`);
    process.stdout.write(`  FAIL  ${label}: ${msg}\n`);
  }
}

function corpusCases(): Array<{
  name: string;
  meta: Record<string, unknown>;
  dir: string;
}> {
  return readdirSync(CORPUS_DIR)
    .filter((name) => statSync(join(CORPUS_DIR, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(CORPUS_DIR, name);
      const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
      return { name, meta, dir };
    });
}

// ---------- case groups -----------------------------------------------------

async function runCorpusParity(): Promise<void> {
  process.stdout.write("corpus parity (real CLI through the fake TUI):\n");
  for (const { name, meta, dir } of corpusCases()) {
    await check(`corpus/${name}`, async () => {
      const expected = JSON.parse(
        readFileSync(join(dir, "expected.json"), "utf8"),
      );
      const res = await runBunCli(meta.argv as string[], {
        caseDir: dir,
        now: meta.now as string,
        tz: meta.tz as string,
        home: sandboxHome(name),
      });
      assertContract(res, expected, meta.expected_exit_code as number);
    });
  }
}

async function runAuthForks(): Promise<void> {
  process.stdout.write("auth-probe forks:\n");
  const forks: Array<{
    id: string;
    overrides: Record<string, unknown>;
    expected: unknown;
  }> = [
    {
      id: "loggedIn-true-no_subscription",
      overrides: { logged_in: true },
      expected: OK_NO_SUB,
    },
    {
      id: "loggedIn-false-signed_out",
      overrides: { logged_in: false },
      expected: OK_SIGNED_OUT,
    },
    {
      id: "loggedIn-garbage-no_subscription",
      overrides: { auth_status_stdout: '{"loggedIn": "yes"}\n' },
      expected: OK_NO_SUB,
    },
  ];
  for (const { id, overrides, expected } of forks) {
    await check(`auth-fork/${id}`, async () => {
      const dest = join(scratch, `case-auth-${crypto.randomUUID()}`);
      const meta = makeCase(dest, "claude-no-subscription", overrides);
      const res = await runBunCli(meta.argv as string[], {
        caseDir: dest,
        now: meta.now as string,
        tz: meta.tz as string,
        home: sandboxHome("auth"),
      });
      assertContract(res, expected as Record<string, unknown>, 0);
    });
  }
}

async function runMountDelays(): Promise<void> {
  process.stdout.write("mount-delay ready-wait race:\n");
  const expected = JSON.parse(
    readFileSync(
      join(CORPUS_DIR, "claude-subscribed", "expected.json"),
      "utf8",
    ),
  );
  for (const mountDelayMs of [0, 1000, 2500]) {
    await check(`mount-delay/${mountDelayMs}ms`, async () => {
      const dest = join(scratch, `case-mount-${crypto.randomUUID()}`);
      const meta = makeCase(dest, "claude-subscribed", {
        mount_delay_ms: mountDelayMs,
      });
      const res = await runBunCli(meta.argv as string[], {
        caseDir: dest,
        now: meta.now as string,
        tz: meta.tz as string,
        home: sandboxHome("mount"),
      });
      assertContract(res, expected, 0);
    });
  }
}

async function runReaping(): Promise<void> {
  process.stdout.write("stubborn-child reaping:\n");
  await check("reaping/bun-sweeps-stubborn-child", async () => {
    const dest = join(scratch, `case-reap-${crypto.randomUUID()}`);
    const meta = makeCase(dest, "claude-subscribed", { fork_child: true });
    const pidfile = join(scratch, `child-${crypto.randomUUID()}.pid`);
    const res = await runBunCli(meta.argv as string[], {
      caseDir: dest,
      now: meta.now as string,
      tz: meta.tz as string,
      home: sandboxHome("reap"),
      extraEnv: { AGENTUSAGE_FAKE_REAP_PIDFILE: pidfile },
    });
    // The scrape itself must still succeed — reaping is about cleanup, not a
    // degraded read.
    const json = parseOneJsonLine(res.stdout);
    assert(json.status === "ok", `expected ok arm, stderr:\n${res.stderr}`);
    assert(res.exitCode === 0, `exit ${res.exitCode} != 0`);
    assert(existsSync(pidfile), "the fake never recorded a forked child");
    const childPid = Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!alive(childPid)) {
        return;
      }
      await sleep(100);
    }
    try {
      process.kill(childPid, "SIGKILL"); // don't leak the survivor past the run
    } catch {
      // already gone in the race between the check and the kill
    }
    throw new AssertionError(
      `left a stubborn child (${childPid}) alive after cleanup`,
    );
  });
}

async function runSubprocessContract(): Promise<void> {
  process.stdout.write("subprocess contract:\n");

  await check("contract/writes-no-state", async () => {
    const home = sandboxHome("nostate");
    const dir = join(CORPUS_DIR, "claude-subscribed");
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
    const res = await runBunCli(meta.argv as string[], {
      caseDir: dir,
      now: meta.now as string,
      tz: meta.tz as string,
      home,
    });
    const json = parseOneJsonLine(res.stdout);
    assert(json.status === "ok", `expected ok arm, stderr:\n${res.stderr}`);
    // The util is stateless: keeper owns every envelope write. No agentusage
    // state may appear under the sandboxed HOME's fixed state dir.
    const stateDir = join(home, ".local", "state", "agentusage");
    assert(!existsSync(stateDir), `util wrote state at ${stateDir}`);
  });

  await check("contract/argv-error-missing-profile", async () => {
    const res = await runBunCli(["--target", "claude"], {});
    assert(res.exitCode === 2, `exit ${res.exitCode} != 2`);
    assert(
      res.stdout === "",
      `expected empty stdout, got: ${JSON.stringify(res.stdout)}`,
    );
    assert(res.stderr.trim().length > 0, "expected a diagnostic on stderr");
  });

  await check("contract/argv-error-missing-target", async () => {
    const res = await runBunCli(["--profile", "default"], {});
    assert(res.exitCode === 2, `exit ${res.exitCode} != 2`);
    assert(
      res.stdout === "",
      `expected empty stdout, got: ${JSON.stringify(res.stdout)}`,
    );
    assert(res.stderr.trim().length > 0, "expected a diagnostic on stderr");
  });
}

// ---------- main ------------------------------------------------------------

async function main(): Promise<number> {
  if (!Bun.which("tmux")) {
    const reason = "tmux is not installed (the Bun scrape driver needs it)";
    if (REQUIRE) {
      process.stderr.write(
        `SKIP→FAIL: AGENTUSAGE_REQUIRE_CONFORMANCE=1 but ${reason}\n`,
      );
      return 1;
    }
    process.stdout.write(`SKIP: ${reason}\n`);
    return 0;
  }

  scratch = mkdtempSync(join(tmpdir(), "agentusage-conformance-"));
  try {
    await runCorpusParity();
    await runAuthForks();
    await runMountDelays();
    await runReaping();
    await runSubprocessContract();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const total = passed + failed;
  process.stdout.write(`\n${passed}/${total} conformance checks passed\n`);
  if (failed > 0) {
    process.stderr.write(`\n${failed} FAILED:\n`);
    for (const f of failures) {
      process.stderr.write(`  - ${f}\n`);
    }
    return 1;
  }
  return 0;
}

process.exit(await main());
