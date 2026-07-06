## Description

**Size:** M
**Files:** src/db.ts, src/usage-scrape-runner.ts, test/usage-scrape-runner.test.ts

### Approach

Add `usage_scraper_runtime` to keeper's config resolution mirroring the existing usage-scraper key shape: env `KEEPER_USAGE_SCRAPER_RUNTIME` wins over config, values `uv|bun`, anything else (or absent) resolves `uv` — fail closed, matching the unrecognized-schema-version house rule. Resolution happens in the per-scrape path (runScrape already re-resolves config each scrape) so a flip or rollback is live without a daemon restart; the resolver's return shape stays compatible so the boot gate that decides worker construction needs no edit even when runtime=bun with uv keys absent. Grow the bun branch in buildScrapeArgs: argv `[<bunPath>, <projectDir>/src/scrape-cli.ts, --target, …, --profile, …]` with the same optional --command/--rows/--cols passthrough as the uv branch; bunPath defaults to the daemon's own process.execPath (absolute under launchd's stripped env) with a `usage_scraper_bun_path` / `KEEPER_USAGE_SCRAPER_BUN_PATH` override; the existing project-dir key locates the entry. Spawn discipline (concurrent drains, 60s SIGKILL, env passthrough incl. CLAUDE_CONFIG_DIR) is shared code and stays untouched — ensure the injected child PATH carries tmux's directory, which the bun leg news into the requirement set. Fast tests cover the resolver precedence/fail-closed matrix and both argv branches purely (string-level, no spawn); a KEEPER_RUN_SLOW round-trip exercises a real bun spawn end-to-end against the agentusage fake-TUI corpus case.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:148-155,367-380,483,535-552 — key declaration/parsing/firstNonEmpty/resolveUsageScraperRuntime, the exact template to extend
- src/usage-scrape-runner.ts:214-244,381-444,453 — buildScrapeArgs, spawnScrape, runScrape per-scrape resolution
- src/daemon.ts:6032 — the boot gate; acceptance requires it unchanged, so read what shape it consumes
- ~/code/keeper/CLAUDE.md — worker read-only db contract and test conventions (fast vs .slow)

### Risks

- fn-1131 edits the same src/db.ts (SCHEMA_VERSION bump); the epic-level dep serializes the epics, but keep this task's db.ts delta tight to the config-key region regardless.
- An env-var override left set on the daemon's LaunchAgent would shadow every config flip silently — the resolver tests must pin env-over-config precedence so the soak runbook can reason about it.

### Test notes

`bun test test/usage-scrape-runner.test.ts` green; `KEEPER_RUN_SLOW=1 bun test <slow file>` green on this box; `bun run lint && bun run typecheck` clean.

## Acceptance

- [ ] Runtime resolves env-over-config with uv default and fail-closed-to-uv on invalid values; covered by fast tests
- [ ] runtime=bun builds argv with an absolute bun binary (execPath default, config/env override) against the agentusage entry, preserving --command/--rows/--cols passthrough; both branches covered by string-level tests
- [ ] A flip takes effect on the next scrape without a daemon restart, and the boot gate file is untouched by the diff
- [ ] The slow round-trip proves a real bun-leg scrape returns a valid contract through parseScrapeStdout
- [ ] Shipped default remains uv — merging this task changes no production behavior

## Done summary

## Evidence
