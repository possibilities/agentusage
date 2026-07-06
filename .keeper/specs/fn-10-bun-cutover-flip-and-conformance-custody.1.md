## Description

**Size:** M
**Files:** src/scrape-cli.ts, src/scrape.ts, src/scrape.test.ts, src/scrape-cli.test.ts, package.json

### Approach

Give `run()` an injectable deps parameter (optional, defaulting to the real `scrape` and `claudeAuthLoggedIn` — keeper seam style, no module mocking) and export `detectSignedOut` so its six variant behaviors stay unit-testable. Then translate the surviving pytest internals case-for-case into bun:test siblings: the pure helper tables (profile extraction, codex resolution with env-as-argument, trust-file idempotence against a tmpdir home, screen excerpt elision, passthrough translation, error-kind classification hit directly), the six signed-out quorum/wrap/alt-screen variants, and the ~20 CLI arm tests through the new deps seam asserting arm payload shape + key-absence rules. Preserve original case names in describe/test titles so the 1:1 mapping audits cleanly; record dead-at-translation dispositions (pexpect pump/fake-child flow tests — no byte pump exists; coverage lives in the corpus path) as a header comment in the new test files. Subprocess-stdout contract cases (writes-no-state, one-JSON-line, argv errors) are explicitly OUT of scope here — they land in the conformance runner task, keeping this file pure in-process and Bun#24690-clean. Add the `test` script to package.json with globs narrowed to src/ (the #24690 fd trigger).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- tests/test_scrape_helpers.py — the full case inventory; :46-119 signed-out variants, :290-421 helper tables, :721-768 profile extraction
- tests/test_scrape_cli.py — the arm tests and _CLASSIFY_CASES table; the key-absence assertions are the wire contract
- src/scrape-cli.ts:12-13,54,307-439 — imported-binding call sites the deps seam replaces; PARSERS mutable record
- src/scrape.ts:628 — detectSignedOut (currently module-private; export it)
- ~/code/keeper/src/usage-scrape-runner.ts:453 — the ScrapeRunner deps-injection precedent to mirror

### Risks

- The deps-seam refactor touches the production CLI; the still-green parity gate is the regression net — run it after the refactor, before translating.
- mock.module is banned here (global leakage); if the seam genuinely cannot reach a case, record it as dead-at-translation with a reason instead.

### Test notes

`bun test` green; `AGENTUSAGE_REQUIRE_PARITY=1 uv run pytest tests/test_bun_parity.py tests/test_dual_run_cli.py` still green (proves the seam refactor changed no behavior).

## Acceptance

- [ ] Every pytest case in the two internals modules has either a same-named bun:test translation or a written dead-at-translation disposition; no case silently dropped
- [ ] run() accepts injected scrape/auth deps and behaves identically when none are passed; the parity gate stays green
- [ ] detectSignedOut is exported with its six variant behaviors covered in bun:test
- [ ] `bun run test` exists and passes without tmux present and without spawning any subprocess

## Done summary

## Evidence
