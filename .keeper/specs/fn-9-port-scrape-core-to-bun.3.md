## Description

**Size:** M
**Files:** tests/fixtures/corpus/, tests/fake_tui.py, tests/record_corpus.py, tests/corpus_schema.md

### Approach

Build the language-neutral conformance fixtures both runtimes consume. Corpus: one directory of per-scenario cases, each carrying the raw ANSI byte transcript the fake TUI replays, the pinned `now` and `TZ`, the CLI argv shape, and the expected contract JSON + exit code (ground-truth-corpus pattern; canonical implementation is Python — generate expected outputs BY RUNNING the Python CLI, never by hand). Scenarios: claude subscribed / subscribed+sonnet / depleted-week (0% null-reset session) / no-sub breakdown / API-billing / endpoint-rate-limited / signed-out OAuth screen / panel-missing / format-drift; codex ok / ok+spark / weekly-drift. Base transcripts are synthesized from the existing inline test fixtures (importable module constants) wrapped in alt-screen entry bytes; scrub any real identifiers length-preservingly. Two structurally-synthetic cases are mandatory: a narrow-cols wrap-split sentinel case (pyte full-width fill vs tmux `-pJ` join equivalence) and a byte-active-but-snapshot-stable spinner case (exercises the snapshot-idle mapping) — no secrets in either so scrubbing cannot shift wrapping. Fake TUI (`tests/fake_tui.py`, stdlib-only Python): multi-modal — invoked as `<fake> auth status` it prints `{"loggedIn": <bool from case config>}` and exits; otherwise it enters the alt screen (`\x1b[?1049h`), optionally sleeps a parametrized mount delay, absorbs input until it sees ctrl-U then a slash command then CR, then replays the case transcript; it tolerates and ignores unknown argv (codex `extra_args`). Recorder (`tests/record_corpus.py`, `live`-marked usage): tees raw child bytes from a real pexpect scrape for scenarios reachable on this box, to validate synthetic transcripts against reality.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- tests/test_parse_claude_usage.py:43-131 — the inline screen fixtures to lift (NO_SUB_SCREEN, API_BILLING_*, SUBSCRIBED_*, DEPLETED_WEEK_SCREEN)
- tests/test_parse_codex_status.py — codex fixtures incl. the live dated panel
- tests/test_scrape_helpers.py:31-44 — `_alt_render`'s alt-screen entry sequence (the canonical boot bytes)
- tests/test_scrape_helpers.py:60-72 — the cols=30 wrap-split signed-out case to mirror as a corpus scenario
- scrape.py:378-386 — send_slash_command's exact byte sequence (ctrl-U, text, CR) the fake TUI must absorb
- agentusage/scrape_cli.py:164-197 — the auth-status probe contract the fake TUI's auth mode satisfies

**Optional** (reference as needed):
- scrape.py:51-122 — TARGETS sentinels each scenario must include so appear/short-circuit branches fire

### Risks

- Expected outputs hand-written instead of Python-generated would encode guesses, not the contract — the generator step is mandatory (run it with AGENTUSAGE_NOW + TZ pinned once task 7 lands the seam; until then pin via the parse-level now= for parser expectations and document CLI-level expectations as generated-in-task-7).
- A fake TUI that paints on boot (not on slash receipt) silently no-ops the retry state machine; the paint gate is load-bearing.

### Test notes

A thin pytest smoke (not the parity module yet): spawn the Python CLI with `--command tests/fake_tui.py` for one subscribed case and assert the ok arm — proves the fake TUI drives the REAL pexpect+pyte path before the bun side exists.

## Acceptance

- [ ] Corpus directory contains all listed claude and codex scenarios plus the wrap-split and spinner structural cases, each with transcript, pinned now/TZ, argv, expected JSON, expected exit code, and a schema doc
- [ ] No corpus file contains a real email, org name, token, or OAuth code (scrub is length-preserving where wrapping matters)
- [ ] `uv run pytest` green: the smoke test drives the Python CLI end-to-end through the fake TUI's subscribed scenario and gets the ok arm
- [ ] Fake TUI answers `auth status` with configurable loggedIn JSON and ignores unknown flags

## Done summary

## Evidence
