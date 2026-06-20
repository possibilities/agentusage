## Description

**Size:** S
**Files:** daemon.py, tests/test_daemon_helpers.py, tests/test_daemon_idle_stale_guard.py, README.md

### Approach

Split `_resolve_multiplier` into a failure-signaling core plus the existing boot wrapper. The core, `_resolve_multiplier_or_none(profile) -> int | None`, returns `None` on every failure path (oversize file, OSError, JSONDecodeError, missing or unknown tier), keeping each existing stderr log line. The boot wrapper `_resolve_multiplier` becomes `_resolve_multiplier_or_none(p) or 1` so `_build_accounts` boot semantics stay byte-identical (a failed read at boot still yields 1x — there is no prior to keep). This split is mandatory because the current helper returns `1` indistinguishably for "read failed" and "legitimately Pro" (`default_claude_ai` → 1), which would silently downgrade a Max account on a transient blip.

In the per-account loop, at the literal top of the `while True:` body — above the `state_path.exists()` idle/cooldown block, so idle and cooling profiles refresh too — for `acct["target"] == "claude"` only: call the core; on a non-None result assign `acct["multiplier"] = result`; on None leave `acct` untouched (the mutable `acct` dict is the keep-prior carrier — the value rides forward across iterations and `_build_envelope` reads it unchanged, no envelope-builder change needed). The core never raises (it catches internally), so a tier-file problem can never bubble into the loop's outer `except Exception` stale-write path and masquerade as a scrape failure.

codex is untouched: no profile dir, no tier, multiplier stays 1.

README.md Multiplier section: replace the "stamps `multiplier` at boot … Restart the daemon to pick up a tier change" prose with per-cycle re-resolution + keep-prior-on-failure. The existing tier table row about the 1x fallback stays (it still describes boot).

### Investigation targets

**Required** (read before coding):
- daemon.py:81 — `_resolve_multiplier`: the function to split; every failure path currently returns 1
- daemon.py:507 — top of the per-account `while True:` body: insertion point, above the idle/cooldown block at :521 (its `continue` branches at :533/:581 write envelopes without scraping — they must carry the refreshed multiplier)
- daemon.py:419-451 — `_build_envelope` reads `acct["multiplier"]`; verify no change needed
- daemon.py:173-198 — `_build_accounts`: boot caller whose 1x-fallback semantics must be preserved
- tests/test_daemon_helpers.py:58-141 — table-driven `_resolve_multiplier` tests with monkeypatched `Path.home` + `_write_claude_json`; extend for the `_or_none` core
- tests/test_daemon_idle_stale_guard.py — async-loop harness: `_install_write_event` (wraps `daemon.write_atomic` in an asyncio.Event), `_drive_one_cycle`, inline Account construction, sync wrappers calling `asyncio.run` (NO pytest-asyncio in dev-deps — follow this pattern exactly)

**Optional** (reference as needed):
- daemon.py:700-760 — outer `except Exception` stale-write path the re-resolve must never reach
- README.md ~line 117 — Multiplier section to update

### Risks

- A `None` leaking into `acct["multiplier"]` would put a null on the envelope contract keeper consumes — the assign-only-on-non-None guard is the whole fix; test it directly.
- Placement below the idle/cooldown `continue`s would mean an idle profile's envelope never refreshes its multiplier — covered by a dedicated test.

### Test notes

- Tier change between cycles: drive one cycle, rewrite the profile's `.claude.json` with a new tier, drive the next cycle, assert the new envelope carries the new multiplier.
- Keep-prior: corrupt/delete `.claude.json` between cycles, assert the next envelope still carries the previous multiplier (not 1).
- Idle-path refresh: with an idle-skip cycle (no scrape), assert the skip envelope still reflects a tier change.
- Boot fallback unchanged: table-driven `_or_none` cases (missing file, oversize, bad JSON, missing tier, unknown tier → None; each real tier → int), plus `_resolve_multiplier` returning 1 on failure.

## Acceptance

- [ ] `_resolve_multiplier_or_none` returns None on every failure path and the correct int for all three tiers; `_resolve_multiplier` (boot) still falls back to 1
- [ ] Multiplier re-resolved at the top of every per-account iteration for claude targets; a tier change appears in the next envelope (scrape, idle-skip, and cooldown paths alike)
- [ ] Read/parse failure preserves the prior multiplier in the next envelope
- [ ] Re-resolve can never raise into the loop's stale-failure handler
- [ ] README Multiplier section no longer says a restart is required
- [ ] `uv run pytest` green

## Done summary
Re-resolve plan-tier multiplier at the top of every fetch cycle (claude targets) via a new _resolve_multiplier_or_none core; keep the prior value on read/parse failure so a transient blip never flickers a Max account to 1x. Boot 1x fallback and codex unchanged; README updated to per-cycle re-resolve.
## Evidence
