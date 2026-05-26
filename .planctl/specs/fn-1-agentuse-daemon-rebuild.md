## Overview

Turn the existing `tuiuse` spike into `agentuse`: a long-lived per-account daemon. The current run-once-and-aggregate workflow is demolished. The PTY scrape primitive and the two strict parsers survive and become the building blocks of a foreground asyncio daemon that scrapes 5 accounts (4 claude profiles + 1 codex) on independent 1–3 minute jittered loops, writes one self-stamped JSON file per account under `~/.local/state/agentuse/`, and survives restarts cheaply via persisted `fetched_at` timestamps. Every result carries a plan `multiplier` field (1x Pro, 5x Max, or 20x Max), making downstream consumers correctness-aware about effective usage capacity.

## Quick commands

- `uv run python daemon.py` — start the daemon in the foreground; Ctrl-C cleanly cancels all account loops.
- `ls -la ~/.local/state/agentuse/` — one JSON file per account with freshness stamps.
- `jq '.fetched_at, .next_fetch_at, .multiplier' ~/.local/state/agentuse/claude-default.json` — inspect a single account's state.

## Acceptance

- [ ] `tuiuse` is renamed to `agentuse` in `pyproject.toml` (name + verb-phrase description); `uv.lock` regenerated.
- [ ] The old orchestration is fully removed: `run_all.py` and `dump_plans.py` no longer exist in the working tree.
- [ ] `scrape.scrape()` returns the rendered screen text directly. No tmp files, no `print(path)`. `scrape.py:main()` is deleted.
- [ ] A foreground `daemon.py` runs an asyncio supervisor that owns one independent scheduling loop per account in an ACCOUNTS registry of exactly 5 entries.
- [ ] Each account scrapes on its own `uniform(60, 180)s` jitter; cold-boot uses `uniform(0, 60)s` to avoid a synchronized pulse.
- [ ] Each account writes `~/.local/state/agentuse/<id>.json` atomically (tempfile + `os.replace` in the state dir).
- [ ] Each JSON record contains: `id`, `target`, `multiplier`, `fetched_at`, `next_fetch_at`, and a `usage` block from the existing parser output (verbatim).
- [ ] Multipliers: `claude-default`=5, `claude-multi-1`=1, `claude-multi-2`=1, `claude-multi-3`=20, `codex`=1. Confirmed against each profile's `~/.claude-profiles/<p>/.claude.json:oauthAccount.organizationRateLimitTier`.
- [ ] Failures write `<id>.error.json` with `failed_at`, `error_type`, `message`; the last good `<id>.json` is preserved across failure. The error file is unlinked on next successful scrape.
- [ ] SIGINT and SIGTERM trigger clean shutdown via `loop.add_signal_handler` with a 30s grace.

## Early proof point

Task that proves the approach: `<epic_id>.1`. If demolition + scrape refactor + project rename land cleanly and the existing parsers continue to work against the refactored `scrape()`, the rest is bookkeeping. If it fails: revert the rename + restore `run_all.py` to verify the original workflow still drives the parsers, then narrow the regression.

## References

- [Python asyncio Runner](https://docs.python.org/3/library/asyncio-runner.html) — `asyncio.run()` SIGINT lifecycle.
- [Python os.replace](https://docs.python.org/3/library/os.html#os.replace) — atomic rename semantics (same filesystem required).
- [Hynek — Waiting in asyncio](https://hynek.me/articles/waiting-in-asyncio/) — task GC gotcha (event loop holds weak refs).
- [roguelynn — Graceful Shutdowns](https://roguelynn.com/words/asyncio-graceful-shutdowns/) — signal handler + cancel + gather pattern.
- `/Users/mike/code/tuiuse/scrape.py:97-147` — current scrape primitive.
- `/Users/mike/code/tuiuse/dump_plans.py:13-17` — tier-string source-of-truth (file is deleted in task 1).

## Docs gaps

- **pyproject.toml**: rewrite `name` (`tuiuse` → `agentuse`) and `description` to a verb phrase about the per-account daemon (e.g. *"Poll Claude and Codex usage per account and write structured JSON state"*). The current description references the old PTY-scrape workflow and will be misleading post-rebuild. This is a rewrite, not an append.

## Best practices

- **Use `loop.run_in_executor` for the `pexpect`-driven `scrape()`:** pexpect is blocking and any direct await from the event loop will freeze every other account loop for 5–20s per cycle.
- **Hold strong references to every `asyncio.create_task` return:** the event loop only holds weak refs and silently GCs tasks otherwise.
- **`tempfile.mkstemp(dir=path.parent)` + `os.replace`** for atomic writes; tmp file must be on the same filesystem as the destination — hence `dir=` to the state dir, not `/tmp/`.
- **Catch `Exception`, not `BaseException`, in the loop body:** `CancelledError` must propagate for clean shutdown via `add_signal_handler` + `asyncio.gather(..., return_exceptions=True)`.
- **Jitter at the start of each iteration**, not the end — measured interval becomes uniform-random instead of uniform-random-plus-scrape-time-noise.
- **`error_path.unlink(missing_ok=True)` on success** to clear stale errors without a race.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/agentuse-daemon` — handoff bundle from `/arthack:sketch` (empty placeholder; created when the sketch was saved).
