## Description

**Size:** M
**Files:** `daemon.py` (new), `~/.local/state/agentuse/` (state dir, created at runtime)

### Approach

Greenfield daemon module. One file at repo root. Run with `uv run python daemon.py` from a terminal — foreground, Ctrl-C clean, no PID file, no launchd unit, no double-fork.

Shape:

1. **ACCOUNTS registry** at top of `daemon.py` — list of dicts with `id`, `target`, `passthrough`, `multiplier`. Values, confirmed by reading `~/.claude-profiles/<p>/.claude.json:oauthAccount.organizationRateLimitTier`:
   - `claude-default` → target=`"claude"`, passthrough=`["--arthack-profile", "default"]`, multiplier=5 (Max 5x)
   - `claude-multi-1` → target=`"claude"`, passthrough=`["--arthack-profile", "multi-claude-1"]`, multiplier=1 (Pro)
   - `claude-multi-2` → target=`"claude"`, passthrough=`["--arthack-profile", "multi-claude-2"]`, multiplier=1 (Pro)
   - `claude-multi-3` → target=`"claude"`, passthrough=`["--arthack-profile", "multi-claude-3"]`, multiplier=20 (Max 20x)
   - `codex` → target=`"codex"`, passthrough=`[]`, multiplier=1

   Comment near the registry traces multipliers to source-of-truth tier strings (`default_claude_ai`=1, `default_claude_max_5x`=5, `default_claude_max_20x`=20). Validate `id` uniqueness at module load (`assert len({a["id"] for a in ACCOUNTS}) == len(ACCOUNTS)`).

2. **Atomic write helper:** `write_atomic(path: Path, payload: dict) -> None` using `tempfile.mkstemp(dir=path.parent, suffix=".tmp")` + `os.fdopen` to write JSON + `os.replace(tmp, path)`. Same-filesystem guarantee. Trailing newline (repo convention).

3. **State layout under `~/.local/state/agentuse/`** — state dir created on startup with `Path.mkdir(parents=True, exist_ok=True)`:
   - `<id>.json` — success record: `{"id", "target", "multiplier", "fetched_at": <iso>, "next_fetch_at": <iso>, "usage": <parser output verbatim>}`. `fetched_at` is ISO-8601 with timezone, captured right before the atomic write.
   - `<id>.error.json` — failure record: `{"id", "target", "multiplier", "failed_at": <iso>, "error_type", "message"}`. Unlinked on next successful scrape (clean state, not history).

4. **Async scheduler** — one independent `asyncio.create_task(account_loop(acct))` per account. Keep strong refs (e.g. `tasks = {asyncio.create_task(...) for acct in ACCOUNTS}`) — the event loop only holds weak refs and silently GCs orphan tasks otherwise.

   Each `account_loop(acct)`:
   - **On startup:** read existing `<id>.json` if present. If `next_fetch_at > now`, sleep `next_fetch_at - now`. If `next_fetch_at <= now` (stale) or file absent/unparseable, sleep `uniform(0, 60)` (cold-boot spread to avoid synchronized pulse), then proceed.
   - **Loop body** (in order):
     1. `delay = random.uniform(60, 180)`
     2. `fetched_at = datetime.now().astimezone()`
     3. `rendered = await asyncio.wait_for(loop.run_in_executor(executor, scrape, acct["target"], acct["passthrough"]), timeout=60)`
     4. `usage = parse(rendered)` (claude vs codex parser dispatched on `target`)
     5. `next_fetch_at = fetched_at + timedelta(seconds=delay)`
     6. atomic-write `<id>.json` with full envelope
     7. `error_path.unlink(missing_ok=True)`
     8. `logger.info("wrote, next_fetch_at=%s", next_fetch_at.isoformat())`
     9. `await asyncio.sleep((next_fetch_at - datetime.now().astimezone()).total_seconds())`
   - **On exception** (bare `except Exception` — let `CancelledError` propagate): atomic-write `<id>.error.json` with `{failed_at, error_type, message}`, log `[<id>] error: <message>`, `await asyncio.sleep(random.uniform(60, 180))`. Do NOT touch `<id>.json`.
   - **On CancelledError:** re-raise after best-effort cleanup (sleep is cancelled instantly; in-flight executor `scrape()` finishes naturally — Python cannot cancel executor threads).

5. **Shared `ThreadPoolExecutor(max_workers=len(ACCOUNTS)+1)`** — set as default executor via `loop.set_default_executor(executor)`.

6. **Shutdown:** in `main()` coroutine, register SIGINT and SIGTERM via `loop.add_signal_handler(sig, shutdown_event.set)` → after event fires, cancel all tasks, `await asyncio.gather(*tasks, return_exceptions=True)` wrapped in a 30s `asyncio.wait_for` grace. Process exits cleanly even if executor threads are still finishing; orphan pexpect children die on process exit.

7. **Logging:** `logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s [%(name)s] %(message)s")`. Per-account logger: `logging.getLogger(f"agentuse.{acct['id']}")`.

### Investigation targets

**Required**:
- `/Users/mike/code/tuiuse/scrape.py:28-51` — `TARGETS` dict (post-task-1 still). The daemon dispatches `scrape()` against `target` keys here.
- `/Users/mike/code/tuiuse/scrape.py` (post-task-1 refactor) — `scrape(target, passthrough) -> str` is the executor entrypoint.
- `/Users/mike/code/tuiuse/parse_claude_usage.py:133` — `parse(text, *, now=None) -> dict`. Output goes verbatim under `"usage"` key.
- `/Users/mike/code/tuiuse/parse_codex_status.py:60` — same shape, for codex.

**Optional**:
- `/Users/mike/code/CLAUDE.md` — state-dir parallel naming convention (`~/.local/state/<name>/`).
- `~/.claude-profiles/<profile>/.claude.json` — tier strings under `oauthAccount.organizationRateLimitTier`. Used to confirm multipliers; daemon hardcodes them in ACCOUNTS.

### Risks

- pexpect runs in an executor thread (blocking PTY). The `asyncio.wait_for(..., 60)` cap protects against wedged scrapes but cannot interrupt the thread — the orphan finishes naturally. Worth a one-line comment near the executor call.
- 1–3 min cadence is dense (~30–60 scrapes/hr/account). If upstream services flag the volume, the `uniform(60, 180)` literal is the tuning knob — no code redesign needed.
- No multi-instance lock: two daemons race the same files. Out of scope this epic; one-line comment near `main()` flags it.
- If a `<id>.json` exists from a hypothetical prior schema, parsing fails and the loop treats it as missing — safe but worth logging the once.
- `scrape()` may hit a TUI auth re-prompt and stall to its 15s sentinel timeout, returning garbage screen → parser raises. Accepted: surfaces as `<id>.error.json`.

### Test notes

- **Smoke**: `mkdir -p ~/.local/state/agentuse && uv run python daemon.py` for ~5 minutes. Expect 5 `<id>.json` files with fresh `fetched_at` stamps. Inspect with `for f in ~/.local/state/agentuse/*.json; do echo "=== $f"; jq '.fetched_at, .next_fetch_at, .multiplier' "$f"; done`.
- **Clean shutdown**: Ctrl-C from the terminal — daemon should exit within ~30s, no zombie pexpect children (`ps aux | grep arthack- | grep -v grep` returns empty).
- **Failure path**: briefly rename `~/.local/bin/arthack-codex.py` away, run daemon — expect `~/.local/state/agentuse/codex.error.json` to appear; `~/.local/state/agentuse/codex.json` (if it exists) untouched. Restore the binary; on next iteration, error file is unlinked and `codex.json` updates.
- **Restart-cheap**: run daemon ~3 minutes, Ctrl-C, restart immediately — verify the next scrape per account waits out the remainder of its `next_fetch_at` (no synchronized pulse).

## Acceptance

- [ ] `daemon.py` exists at repo root, runnable via `uv run python daemon.py`.
- [ ] ACCOUNTS registry contains exactly 5 entries with multipliers: `claude-default`=5, `claude-multi-1`=1, `claude-multi-2`=1, `claude-multi-3`=20, `codex`=1. `id` uniqueness is asserted at module load.
- [ ] State dir `~/.local/state/agentuse/` is created at startup if missing.
- [ ] Each account writes `<id>.json` with the envelope `{id, target, multiplier, fetched_at, next_fetch_at, usage}`. `fetched_at` and `next_fetch_at` are ISO-8601 with timezone. `usage` matches the parser's verbatim output.
- [ ] All writes are atomic via `tempfile.mkstemp(dir=path.parent)` + `os.replace` — tmp file lives in the destination directory.
- [ ] Each account has its own scheduling loop with `uniform(60, 180)s` jitter; no global tick. Cold-boot (no state file) uses `uniform(0, 60)s` for the first sleep.
- [ ] On failure, `<id>.error.json` is written with `{id, target, multiplier, failed_at, error_type, message}`. The existing `<id>.json` is untouched. On the next successful scrape, `<id>.error.json` is unlinked via `unlink(missing_ok=True)`.
- [ ] SIGINT and SIGTERM trigger clean shutdown via `loop.add_signal_handler`; `asyncio.gather(*tasks, return_exceptions=True)` wrapped in a 30s grace.
- [ ] Logging goes to stderr at INFO level via stdlib `logging`; per-account logger name is `agentuse.<id>`; per-cycle log line includes the action and `next_fetch_at`.
- [ ] Restart-cheap smoke passes: a daemon restart within `uniform(60, 180)s` of the prior scrape sleeps the remainder rather than firing a synchronized pulse.

## Done summary
Added daemon.py at repo root: 5-account asyncio supervisor with per-loop 1-3min jitter, restart-cheap state via prior next_fetch_at, atomic JSON writes under ~/.local/state/agentuse/, separate <id>.error.json on failure, and SIGINT/SIGTERM clean shutdown.
## Evidence
