#!/usr/bin/env bash
# Best-effort installation of the claude-swap fork agentusage observes.
# Safe to re-run; it refuses rather than clobbering foreign state, and a
# failure here never blocks agentusage's own install.
#
# Each provider owns its own installation. codex-swap ships scripts/install.sh,
# which provisions the codex-multi-auth fork it needs and bakes that path into
# its own command; claude-swap's fork is owned by the cswax workshop, which
# ships the installer called below. A shim or a checkout dance written from
# here would overwrite what those own — one command, one owner.
set -uo pipefail

status=0

# ── claude-swap (cswap) ─────────────────────────────────────────────────────
# The public fork's integration branch is the stable provider contract: it
# carries the capacity metadata and expired-token recovery agentusage consumes.
#
# Maintaining that fork is not this script's job and never was a safe place for
# it. Rebasing, gating, and force-pushing the fork used to happen here, on every
# unattended machine converge; it now lives in the cswax workshop
# (`~/code/cswax`), which runs it deliberately through the shared `maintain`
# skill. An ordinary install must be able to bind and install the fork without
# ever being able to rewrite or publish it.
#
# So this is a pure consumer: one call to the workshop's installer, which owns
# the checkout, the fork-remote identity check, the refusal to install a dirty
# or unpublished tree, and the `uv tool install`. One command, one owner — the
# same reason this file stopped writing codex-swap's shim.
install_claude_swap() {
    local installer="${AGENTUSAGE_CSWAX_INSTALLER:-$HOME/code/cswax/scripts/install.sh}"

    if [ ! -x "${installer}" ]; then
        printf 'agentusage providers: the cswax workshop is missing at %s; skipping claude-swap.\n' \
            "${installer}"
        return 1
    fi
    "${installer}" --install --published
}

install_claude_swap || status=1

exit "${status}"
