/**
 * bun:test translation of tests/test_scrape_helpers.py — the pure, in-process
 * helpers on scrape.ts: --agentwrap-profile extraction, codex-command
 * resolution, claude/codex trust-file pre-marking, and the OAuth signed-out
 * quorum. Titles keep the original pytest case names so the 1:1 mapping audits.
 *
 * Dead-at-translation (no bun:test sibling — coverage lives in the corpus /
 * conformance path, task 2+, not this pure-in-process file):
 *   - test_scrape_raises_signed_out_pre_send, test_scrape_detector_exception_propagates,
 *     test_scrape_does_not_pass_setsid_preexec, test_scrape_prepends_spawn_command_dir_to_path,
 *     test_scrape_sets_named_claude_profile_env_and_trusts_tmp,
 *     test_scrape_resolves_codex_command_and_marks_tmp_trusted,
 *     test_scrape_short_circuits_on_no_subscription_or_endpoint_error,
 *     test_scrape_retries_and_warns_when_appear_sentinel_never_matches,
 *     test_scrape_waits_for_optional_followup_and_settles,
 *     test_scrape_handles_gone_sentinel_warning,
 *     test_scrape_uses_idle_fallback_when_no_sentinels,
 *     test_scrape_cleanup_swallows_child_and_process_group_failures
 *       — scrape() now drives a real tmux server, not a pexpect fake child; the
 *         orchestration state machine has no in-process seam and is exercised
 *         end-to-end through the fake TUI in the dual-run / conformance path.
 *   - test_pump_until_any_text_returns_first_present_sentinel,
 *     test_pump_helpers_treat_pty_eio_as_closed_output,
 *     test_pump_helpers_feed_chunks_before_stopping,
 *     test_send_slash_command_clears_types_and_submits
 *       — the pyte byte-pump is gone: the tmux driver polls capture-pane
 *         snapshots and types via `send-keys`, so there is no byte-feed / EOF /
 *         EIO surface to unit-test; the keystroke shape rides the corpus path.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  detectSignedOut,
  ensureClaudeDirTrusted,
  ensureCodexDirTrusted,
  extractClaudeProfile,
  resolveCodexCommand,
  type SignInProbe,
  TARGETS,
} from "./scrape";

// The sentinels the claude target fingerprints the OAuth sign-in screen with.
const SIGNIN_SENTINELS = TARGETS.claude.signedOutSentinels ?? [];

const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "agentusage-scrape-test-"));
  tmpDirs.push(d);
  return d;
}

function touchExecutable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/** Canned tmux probe: feed a fixed alt-screen state and captured screen text so
 *  the quorum logic runs without a live tmux server (mirrors the pyte Screen the
 *  python cases hand-render). */
function screenProbe(
  altOn: boolean,
  captured: string,
  exitCode = 0,
): SignInProbe {
  return {
    alternateOn: () => Promise.resolve(altOn),
    capturePane: () => Promise.resolve({ stdout: captured, exitCode }),
  };
}

afterAll(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("detectSignedOut — OAuth signed-out quorum", () => {
  test("test_detect_signed_out_quorum_classifies_signin", async () => {
    // Two of three sentinels present (paste prompt + authorize URL, no banner).
    const captured = [
      "Sign in to continue",
      "Browser didn't open? Visit:",
      "https://claude.ai/oauth/authorize?client_id=abc&scope=read",
      "",
      "Paste code here > ",
    ].join("\n");
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(true, captured),
      ),
    ).toBe(true);
  });

  test("test_detect_signed_out_matches_wrap_split_url", async () => {
    // A narrow terminal wraps the authorize URL mid-token: "/oauth/authorize"
    // sits on NO single display line, yet the dewrapped corpus reconstructs it.
    // Paired with the paste prompt that is a 2-of-3 quorum.
    const captured = [
      "Visit https://claude.ai/oauth/aut",
      "horize?code=1",
      "Paste code here > ",
    ].join("\n");
    expect(
      captured.split("\n").some((line) => line.includes("/oauth/authorize")),
    ).toBe(false);
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(true, captured),
      ),
    ).toBe(true);
  });

  test("test_detect_signed_out_requires_alt_screen", async () => {
    // Same sign-in content but the TUI never took the alt-screen buffer — a
    // sentinel in the normal buffer / scrollback must not spoof a sign-in.
    const captured = [
      "https://claude.ai/oauth/authorize?client_id=abc",
      "Paste code here > ",
    ].join("\n");
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(false, captured),
      ),
    ).toBe(false);
  });

  test("test_detect_signed_out_single_needle_not_enough", async () => {
    // The banner alone (1 of 3) can paint off the auth screen; it must not trip.
    const captured = [
      "Welcome to Claude Code",
      "Tips for getting started:",
    ].join("\n");
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(true, captured),
      ),
    ).toBe(false);
  });

  test("test_detect_signed_out_ignores_trust_dialog", async () => {
    // A logged-out profile can also hit the trust dialog; it carries none of the
    // OAuth sentinels, so it must not classify as signed_out.
    const captured = [
      "Do you trust the files in this folder?",
      "/private/tmp/agentusage-scrape-xyz",
      "",
      "1. Yes, proceed",
      "2. No, exit",
    ].join("\n");
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(true, captured),
      ),
    ).toBe(false);
  });

  test("test_detect_signed_out_ignores_slow_panel", async () => {
    // A merely-slow /usage panel still rendering its header is not a sign-in.
    const captured = [
      "Settings  Status   Config   Usage   Stats",
      "",
      "Loading usage...",
    ].join("\n");
    expect(
      await detectSignedOut(
        "sess",
        SIGNIN_SENTINELS,
        2,
        screenProbe(true, captured),
      ),
    ).toBe(false);
  });
});

describe("ensureClaudeDirTrusted — trust pre-marking", () => {
  test("test_ensure_claude_dir_trusted_marks_project_and_is_idempotent", () => {
    const configDir = join(mkTmp(), "profile");
    mkdirSync(configDir);
    const claudeJson = join(configDir, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));

    ensureClaudeDirTrusted(configDir, "/private/tmp");

    const data = JSON.parse(readFileSync(claudeJson, "utf8")) as {
      projects: Record<
        string,
        { isTrusted?: boolean; hasTrustDialogAccepted?: boolean }
      >;
    };
    const entry = data.projects["/private/tmp"];
    expect(entry.isTrusted).toBe(true);
    expect(entry.hasTrustDialogAccepted).toBe(true);

    const before = readFileSync(claudeJson, "utf8");
    ensureClaudeDirTrusted(configDir, "/private/tmp");
    expect(readFileSync(claudeJson, "utf8")).toBe(before);
  });

  test("test_ensure_claude_dir_trusted_ignores_missing_or_invalid_config", () => {
    const root = mkTmp();
    const missing = join(root, "missing-profile");
    ensureClaudeDirTrusted(missing, "/private/tmp");
    expect(existsSync(join(missing, ".claude.json"))).toBe(false);

    const configDir = join(root, "profile");
    mkdirSync(configDir);
    const claudeJson = join(configDir, ".claude.json");
    writeFileSync(claudeJson, "not json");

    ensureClaudeDirTrusted(configDir, "/private/tmp");
    expect(readFileSync(claudeJson, "utf8")).toBe("not json");
  });
});

describe("ensureCodexDirTrusted — trust pre-marking", () => {
  test("test_ensure_codex_dir_trusted_appends_once", () => {
    const home = mkTmp();

    // No config.toml yet — nothing to mark.
    ensureCodexDirTrusted("/private/tmp/agentusage", home);
    const cfg = join(home, ".codex", "config.toml");
    expect(existsSync(cfg)).toBe(false);

    mkdirSync(join(home, ".codex"));
    writeFileSync(cfg, 'model = "gpt"\n');
    ensureCodexDirTrusted("/private/tmp/agentusage", home);
    ensureCodexDirTrusted("/private/tmp/agentusage", home);

    const text = readFileSync(cfg, "utf8");
    expect(text.split('[projects."/private/tmp/agentusage"]').length - 1).toBe(
      1,
    );
    expect(text.includes('trust_level = "trusted"')).toBe(true);
  });
});

describe("resolveCodexCommand — codex-command resolution", () => {
  test("test_resolve_codex_command_prefers_latest_nvm_over_pnpm", () => {
    const tmp = mkTmp();
    const oldNvm = touchExecutable(
      join(tmp, ".nvm/versions/node/v20.1.0/bin/codex"),
    );
    const newNvm = touchExecutable(
      join(tmp, ".nvm/versions/node/v24.16.0/bin/codex"),
    );
    const pnpm = touchExecutable(join(tmp, "Library/pnpm/bin/codex"));

    const resolved = resolveCodexCommand({
      home: tmp,
      env: { PATH: dirname(pnpm) },
      whichCodex: pnpm,
    });

    expect(resolved).toBe(newNvm);
    expect(resolved).not.toBe(oldNvm);
  });

  test("test_resolve_codex_command_honors_explicit_env", () => {
    const tmp = mkTmp();
    const explicit = join(tmp, "custom-codex");

    const resolved = resolveCodexCommand({
      home: tmp,
      env: { AGENTUSAGE_CODEX_COMMAND: explicit },
      whichCodex: null,
    });

    expect(resolved).toBe(explicit);
  });

  test("test_resolve_codex_command_uses_path_candidate", () => {
    const tmp = mkTmp();
    const pathCodex = touchExecutable(join(tmp, "bin/codex"));

    const resolved = resolveCodexCommand({
      home: tmp,
      env: { PATH: "" },
      whichCodex: pathCodex,
    });

    expect(resolved).toBe(pathCodex);
  });

  test("test_resolve_codex_command_handles_non_numeric_nvm_version", () => {
    const tmp = mkTmp();
    const betaCodex = touchExecutable(
      join(tmp, ".nvm/versions/node/v24.beta.0/bin/codex"),
    );

    const resolved = resolveCodexCommand({
      home: tmp,
      env: { PATH: "" },
      whichCodex: null,
    });

    expect(resolved).toBe(betaCodex);
  });

  test("test_resolve_codex_command_falls_back_to_binary_name", () => {
    // Nothing resolves — the injected executable check fails every candidate, so
    // the ultimate fallback is the bare binary name (mirrors the python case's
    // monkeypatched `_executable` -> False).
    const tmp = mkTmp();

    const resolved = resolveCodexCommand({
      home: tmp,
      env: { PATH: "" },
      whichCodex: null,
      isExecutable: () => false,
    });

    expect(resolved).toBe("codex");
  });

  test("test_resolve_codex_command_defaults_env", () => {
    const tmp = mkTmp();

    const resolved = resolveCodexCommand({ home: tmp, whichCodex: null });

    expect(typeof resolved).toBe("string");
  });
});

describe("extractClaudeProfile — --agentwrap-profile extraction", () => {
  const cases: Array<{
    name: string;
    args: string[];
    remaining: string[];
    profile: string | null;
  }> = [
    {
      name: "space form",
      args: ["--agentwrap-profile", "foo"],
      remaining: [],
      profile: "foo",
    },
    {
      name: "equals form",
      args: ["--agentwrap-profile=foo"],
      remaining: [],
      profile: "foo",
    },
    {
      name: "flag absent — everything passes through",
      args: ["--model", "opus", "--print"],
      remaining: ["--model", "opus", "--print"],
      profile: null,
    },
    { name: "empty input", args: [], remaining: [], profile: null },
    {
      name: "interleaved (space form)",
      args: ["--model", "opus", "--agentwrap-profile", "foo", "--print"],
      remaining: ["--model", "opus", "--print"],
      profile: "foo",
    },
    {
      name: "interleaved (equals form)",
      args: ["--model", "opus", "--agentwrap-profile=foo", "--print"],
      remaining: ["--model", "opus", "--print"],
      profile: "foo",
    },
    {
      name: "multiple occurrences: last wins (space form)",
      args: ["--agentwrap-profile", "foo", "--agentwrap-profile", "bar"],
      remaining: [],
      profile: "bar",
    },
    {
      name: "multiple occurrences: last wins (mixed forms)",
      args: ["--agentwrap-profile=foo", "--agentwrap-profile", "bar"],
      remaining: [],
      profile: "bar",
    },
    {
      name: "trailing flag with no value falls through",
      args: ["--agentwrap-profile"],
      remaining: ["--agentwrap-profile"],
      profile: null,
    },
    {
      name: "no-value trailing flag after real passthrough args",
      args: ["--model", "opus", "--agentwrap-profile"],
      remaining: ["--model", "opus", "--agentwrap-profile"],
      profile: null,
    },
  ];

  for (const c of cases) {
    test(`test_extract_claude_profile — ${c.name}`, () => {
      const [remaining, profile] = extractClaudeProfile(c.args);
      expect(remaining).toEqual(c.remaining);
      expect(profile).toBe(c.profile);
    });
  }
});
