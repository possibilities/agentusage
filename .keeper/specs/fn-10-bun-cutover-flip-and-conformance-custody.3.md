## Description

**Size:** M
**Files:** tests/fixtures/corpus/, tests/generate.ts, scripts/conformance.ts, src/parse-conformance.test.ts, package.json, tests/corpus_schema.md

### Approach

Make the corpus self-sufficient once Python is gone. (1) Freeze rendered screens: run the existing python generator machinery one final authoritative time to emit a `screen.txt` per corpus case (the pyte-rendered text the parsers consume), and record provenance (python commit hash + exact invocation) in corpus_schema.md. (2) In-process parse conformance: a bun:test module feeding every frozen screen through the TS parsers and deep-comparing against expected.json — tmux-free, subprocess-free, runs in plain `bun test`. (3) End-to-end runner: `scripts/conformance.ts` (standalone `bun run conformance`, NOT bun test) drives the real bun CLI through fake-tui.ts for every corpus case with pinned AGENTUSAGE_NOW/TZ and sandboxed HOME, capturing stdout via temp files, asserting semantic JSON + exit codes + exactly-one-line discipline; it also absorbs the subprocess contract cases from the pytest suite (writes-no-state, argv-error exits) and the reaping assertion. Skip discipline: tmux-absent hosts report reasoned skips; `AGENTUSAGE_REQUIRE_CONFORMANCE=1` promotes skips to failures (successor to REQUIRE_PARITY). (4) `tests/generate.ts`: regenerate expected.json from frozen screens via the TS parsers (byte-identical against current goldens proves it), so parser changes can re-derive goldens without Python; genuinely new scenarios document the tmux-render path in corpus_schema.md.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- tests/fixtures/corpus/generate.py — the render+parse pipeline being frozen and re-expressed in bun
- tests/conftest.py:75,116 — skip_or_fail promotion and render_transcript, the shapes the bun runner replicates
- tests/test_dual_run_cli.py — the assertion inventory the runner must preserve (one-line, exit codes, HOME sandbox)
- src/parse-bridge.ts — reuse its parser plumbing for generate.ts rather than re-mapping error types

**Optional** (reference as needed):
- tests/test_corpus_smoke.py — the python-CLI smoke this runner supersedes on the bun side

### Risks

- A screen.txt frozen from a stale pyte render would bake in a wrong contract; freezing must byte-match what test_bun_parity already validated this week (the parity gate green is the precondition).
- The runner must not glob-walk the repo under bun test semantics — it is a plain script precisely to stay out of #24690 territory; keep it that way.

### Test notes

`bun test` green (includes the new parse-conformance module); `AGENTUSAGE_REQUIRE_CONFORMANCE=1 bun run conformance` green on this box; `bun tests/generate.ts --check` (or equivalent) proves regenerated goldens are byte-identical.

## Acceptance

- [ ] Every corpus case carries a frozen screen.txt with provenance recorded; in-process parse conformance covers all cases in plain bun test
- [ ] `bun run conformance` exists, drives the real CLI through the bun fake TUI for every scenario incl. auth forks and reaping, captures via temp files, and passes with zero skips under the promotion env on this box
- [ ] generate.ts regenerates expected.json from frozen screens byte-identically to the checked-in goldens
- [ ] The pytest parity gate remains green and untouched — custody artifacts are additive this epic

## Done summary
Froze per-case screen.txt (provenance recorded), added in-process bun parse-conformance over the frozen screens, a standalone bun run conformance end-to-end runner (corpus + auth forks + mount-delay + reaping + writes-no-state/argv-error, temp-file capture, skip->fail promotion), and tests/generate.ts regenerating goldens byte-identically. bun test 103 pass; conformance 24/24 under REQUIRE_CONFORMANCE=1; parity gate 45 pass untouched.
## Evidence
