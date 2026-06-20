## Overview

The daemon resolves each claude profile's plan-tier multiplier (Pro=1, Max-5x=5, Max-20x=20) from `~/.claude-profiles/<p>/.claude.json` only once, at module import (`ACCOUNTS = _build_accounts()`). A subscription change mid-run never reaches the envelopes, so keeper's `keeper usage` shows the boot-time tier until the daemon restarts (observed live: `default` at max_20x on disk but multiplier 5 in its envelope). End state: the multiplier is re-resolved every fetch cycle, a tier change shows up in the envelope within one cycle, and a transient read failure keeps the prior value instead of flickering to 1x. keeper needs no changes — its usage-worker change-gate already includes `multiplier`, so corrected envelopes auto-propagate.

## Quick commands

- `uv run pytest tests/ -k multiplier` — unit coverage for resolve + keep-prior
- `for p in default multi-claude-1 multi-claude-2 multi-claude-3; do echo "$p: tier=$(python3 -c "import json;print(json.load(open('$HOME/.claude-profiles/$p/.claude.json')).get('oauthAccount',{}).get('organizationRateLimitTier'))") envelope=$(python3 -c "import json;print(json.load(open('$HOME/.local/state/agentuse/$p.json')).get('multiplier'))")"; done` — live tier-vs-envelope comparison (after a daemon restart + one cycle, these must agree)

## Acceptance

- [ ] A tier change in `.claude.json` is reflected in the profile's envelope within one fetch cycle, without a daemon restart
- [ ] A read/parse failure of `.claude.json` preserves the prior multiplier (no 1x flicker); boot-time 1x fallback behavior unchanged
- [ ] codex envelope unaffected (multiplier stays 1)

## Early proof point

Task that proves the approach: ordinal 1 (the only task). If it fails: the fallback is resolving inside `_build_envelope` instead of the loop top — same keep-prior semantics, slightly wider blast radius.

## References

- keeper's `src/usage-worker.ts` `usageGateKey` — `multiplier` is in the change-gate, so a corrected envelope fires exactly one synthetic UsageSnapshot (no keeper change needed)
- Root-cause trace: `daemon.py:201` (boot-time ACCOUNTS), `daemon.py:81` (`_resolve_multiplier`), `daemon.py:441` (`_build_envelope` stamps `acct["multiplier"]`)

## Docs gaps

- **README.md** (Multiplier section, ~line 117): update "stamps at boot / restart the daemon to pick up a tier change" to per-cycle re-resolve with keep-prior-on-failure — handled inside the task
