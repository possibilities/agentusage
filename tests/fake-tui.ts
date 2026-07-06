#!/usr/bin/env bun

/**
 * Scripted stand-in for the real claude/codex TUI, driven by a corpus case.
 *
 * The bun port of fake_tui.py with byte-identical observable behavior. Both
 * scrape CLIs (the authoritative Python pexpect driver AND the Bun tmux driver)
 * point their `--command` at THIS script so the conformance corpus replays
 * byte-for-byte against the same fake terminal under both runtimes — the
 * strongest available cross-runtime check while the Python CLI still exists. The
 * case to replay is selected by `AGENTUSAGE_FAKE_CASE`, an absolute path to a
 * corpus case directory holding `case.json` + `transcript.ansi`.
 *
 * Multi-modal, matching the two ways the scrape CLI invokes the target binary:
 *
 * 1. `fake-tui.ts auth status` (any argv containing `auth`) — prints
 *    `{"loggedIn": <bool>}` from the case's `logged_in` field and exits. This
 *    satisfies the CLI's no-bar auth probe.
 * 2. otherwise — TUI mode. Enters the alternate screen, waits the case's mount
 *    delay, then EITHER replays immediately (`paint_on_boot` cases, e.g. the
 *    OAuth sign-in screen the scraper classifies PRE-SEND) OR absorbs input
 *    until it sees the scraper's ctrl-U + `/slash` + CR clear-type-submit
 *    sequence and only THEN replays the transcript. The paint-on-slash gate is
 *    load-bearing: painting on boot would silently no-op the scraper's retry
 *    state machine.
 *
 * Unknown argv (e.g. codex's `--dangerously-bypass-approvals-and-sandbox`) is
 * tolerated and ignored. Spawned directly (execvp via the shebang) by both
 * drivers, so it must stay executable.
 */

import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Absolute time budget for a single TUI invocation. A driver snapshots and
// reaps the fake in well under this; the cap only exists so a misdriven fake can
// never wedge a test run. It MUST outlive the driver's whole scrape, or the fake
// exits mid-drive and the driver captures a dead pane. AGENTUSAGE_FAKE_MAX_SECONDS
// lets the dual-run harness raise the ceiling above the pexpect driver's
// two-attempt sentinel budget; the default stays tight.
const MAX_SESSION_SECONDS = Number(
  process.env.AGENTUSAGE_FAKE_MAX_SECONDS ?? "30",
);

// Argv marker the fake uses to re-spawn ITSELF as the stubborn reaping child
// (below). Never produced by a scrape CLI, so it can't collide with real argv.
const STUBBORN_CHILD_MARKER = "__agentusage_stubborn_child__";

const ALT_SCREEN_ENTER = Buffer.from("\x1b[?1049h", "latin1");
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const CR = 0x0d;
const LF = 0x0a;
const SLASH = 0x2f; // "/"

interface CaseConfig {
  logged_in?: unknown;
  auth_status_stdout?: unknown;
  paint_on_boot?: unknown;
  mount_delay_ms?: unknown;
  fork_child?: unknown;
}

function loadCase(): { config: CaseConfig; transcript: Buffer } {
  const caseDir = process.env.AGENTUSAGE_FAKE_CASE;
  if (!caseDir) {
    process.stderr.write("fake-tui: AGENTUSAGE_FAKE_CASE is unset\n");
    process.exit(2);
  }
  const config = JSON.parse(
    readFileSync(join(caseDir, "case.json"), "utf8"),
  ) as CaseConfig;
  const transcript = readFileSync(join(caseDir, "transcript.ansi"));
  return { config, transcript };
}

function runAuthMode(config: CaseConfig): number {
  // `auth_status_stdout`, when present, is emitted verbatim so a case can drive
  // the CLI's no-bar auth probe with a non-bool / malformed `loggedIn` (the
  // probe then reads inconclusive and the account stays no_subscription). Absent
  // → the normal boolean shape from the case's `logged_in`.
  const raw = config.auth_status_stdout;
  if (raw !== undefined && raw !== null) {
    process.stdout.write(String(raw));
  } else {
    process.stdout.write(
      `${JSON.stringify({ loggedIn: Boolean(config.logged_in) })}\n`,
    );
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ReadResult = Buffer | "eof" | "timeout";

/**
 * Pull-based reader over the raw stdin stream. The driver's keystrokes arrive as
 * discrete `data` chunks (raw mode delivers control bytes verbatim); this queues
 * them so `next()` can consume byte runs with a deadline, mirroring the Python
 * fake's `select`-then-`os.read` loop. Attached once, before the mount delay, so
 * keystrokes buffered during a slow mount are never dropped.
 */
function makeStdinReader() {
  const chunks: Buffer[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  const wake = () => {
    const n = notify;
    notify = null;
    if (n) {
      n();
    }
  };
  process.stdin.on("data", (d: Buffer) => {
    chunks.push(d);
    wake();
  });
  process.stdin.on("end", () => {
    ended = true;
    wake();
  });
  process.stdin.on("error", () => {
    ended = true;
    wake();
  });
  process.stdin.resume();

  return {
    async next(deadline: number): Promise<ReadResult> {
      for (;;) {
        const chunk = chunks.shift();
        if (chunk) {
          return chunk;
        }
        if (ended) {
          return "eof";
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return "timeout";
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          // Poll cap mirrors the Python select() 0.2s tick so a deadline with no
          // further input still returns promptly.
          const timer = setTimeout(
            () => {
              if (notify === resolve) {
                notify = null;
              }
              resolve();
            },
            Math.min(remaining, 200),
          );
          timer.unref?.();
        });
      }
    },
  };
}

type StdinReader = ReturnType<typeof makeStdinReader>;

/**
 * Absorb stdin until the scraper's ctrl-U, /slash, CR sequence arrives. Mirrors
 * scrape.sendSlashCommand's exact bytes: ctrl-U (clear line), the literal slash
 * command, then a carriage return. Returns true once a CR/LF lands after a
 * ctrl-U with a `/` in the buffer, false on EOF or timeout.
 */
async function waitForSlashSubmit(
  reader: StdinReader,
  deadline: number,
): Promise<boolean> {
  let seenCtrlU = false;
  let buf: number[] = [];
  while (Date.now() < deadline) {
    const r = await reader.next(deadline);
    if (r === "timeout") {
      continue;
    }
    if (r === "eof") {
      return false;
    }
    for (const byte of r) {
      if (byte === CTRL_U) {
        seenCtrlU = true;
        buf = [];
      } else if (seenCtrlU && (byte === CR || byte === LF)) {
        if (buf.includes(SLASH)) {
          return true;
        }
        seenCtrlU = false;
        buf = [];
      } else if (seenCtrlU) {
        buf.push(byte);
      }
    }
  }
  return false;
}

/**
 * Keep the pane alive (discarding input) until EOF, a ctrl-C, or the deadline.
 * The scraper snapshots the rendered screen and then reaps the process group;
 * staying readable until then keeps the alt-screen buffer up, matching a real
 * TUI that only exits on the ctrl-C the scraper's cleanup sends. Raw mode
 * disables signal generation, so honor that ctrl-C explicitly for a prompt exit.
 */
async function drainUntilClose(
  reader: StdinReader,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const r = await reader.next(deadline);
    if (r === "timeout" || r === "eof") {
      return;
    }
    if (r.includes(CTRL_C)) {
      return;
    }
  }
}

/**
 * Re-spawn this script as a background child that shares the fake's process
 * group and survives the driver's gentle signals — the reaping corpus's stand-in
 * for a TUI that leaves a grandchild behind. Deliberately NOT detached: it stays
 * in the fake's session/process-group and inherits the controlling PTY, the
 * exact shape the pexpect killpg and the tmux kill-session cleanups sweep as a
 * unit. The cross-platform reap that actually ends it is the kernel's SIGHUP to
 * the foreground process group when the session leader (the fake) dies, so the
 * child ignores only the gentle interactive stops (SIGINT/SIGTERM) — SIGHUP and
 * SIGKILL still end it.
 */
function forkStubbornChild(): void {
  const child = spawn(
    process.execPath,
    [import.meta.path, STUBBORN_CHILD_MARKER],
    {
      detached: false,
      stdio: "inherit",
      env: process.env,
    },
  );
  child.unref();
}

function runStubbornChildMode(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    // Empty handler = ignore, so a mere ctrl-c / terminate() can't be mistaken
    // for a real reap. SIGHUP (session-leader death) and SIGKILL still end us.
    process.on(sig, () => {});
  }
  const pidfile = process.env.AGENTUSAGE_FAKE_REAP_PIDFILE;
  if (pidfile) {
    // Record the PID atomically so the harness can assert no survivor after each
    // CLI's cleanup.
    try {
      const tmp = `${pidfile}.${process.pid}.tmp`;
      writeFileSync(tmp, String(process.pid));
      renameSync(tmp, pidfile);
    } catch {
      // best-effort; a driver that reaps us needs no pidfile
    }
  }
  // Self-exit after the session cap so a driver that FAILS to reap us still
  // can't leak past the test run. The interval keeps the event loop alive.
  const deadline = Date.now() + MAX_SESSION_SECONDS * 1000;
  const timer = setInterval(() => {
    if (Date.now() >= deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 200);
}

async function runTuiMode(
  config: CaseConfig,
  transcript: Buffer,
): Promise<number> {
  const deadline = Date.now() + MAX_SESSION_SECONDS * 1000;

  // Raw mode so the scraper's ctrl-U (line-kill in cooked mode) and other
  // control bytes reach us verbatim, exactly as a real raw-mode Ink TUI reads
  // them. Absent a controlling tty (defensive), proceed without raw setup.
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch {
    // no tty under some harnesses; degrade quietly
  }

  const reader = makeStdinReader();

  process.stdout.write(ALT_SCREEN_ENTER);

  const mountDelayMs = Number(config.mount_delay_ms) || 0;
  if (mountDelayMs) {
    await sleep(Math.min(mountDelayMs, MAX_SESSION_SECONDS * 1000));
  }

  if (!config.paint_on_boot) {
    // The scraper types the slash command only after the panel is ready to
    // receive it; block until that sequence arrives before painting.
    if (!(await waitForSlashSubmit(reader, deadline))) {
      return 0;
    }
  }

  process.stdout.write(transcript);
  // Reaping corpus: leave a stubborn grandchild in the group so the harness can
  // confirm each CLI's cleanup sweeps it, not just the fake.
  if (config.fork_child) {
    forkStubbornChild();
  }
  await drainUntilClose(reader, deadline);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { config, transcript } = loadCase();
  // The CLI's auth probe invokes `<command> auth status`; any argv carrying
  // `auth` selects the JSON probe response over the TUI replay.
  if (argv.includes("auth")) {
    return runAuthMode(config);
  }
  return runTuiMode(config, transcript);
}

// The stubborn reaping child re-enters this same script; branch before any case
// load (it owns no corpus case, only the pidfile + self-exit).
if (process.argv.slice(2).includes(STUBBORN_CHILD_MARKER)) {
  runStubbornChildMode();
} else {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
