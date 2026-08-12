#!/usr/bin/env bash
# Best-effort provisioning of the claude-swap fork agentusage observes.
# Safe to re-run; each step skips or refuses rather than clobbering foreign
# state. Failures here never block agentusage's own install.
#
# The other provider installs itself: codex-swap ships scripts/install.sh,
# which also provisions the codex-multi-auth fork it needs and bakes that
# path into its own command. A shim written from here would have overwritten
# that, so this file stopped writing one — one command, one owner.
set -uo pipefail

BIN_DIR="${AGENTUSAGE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
CSWAP_CHECKOUT="${AGENTUSAGE_CSWAP_CHECKOUT:-$HOME/src/claude-swap}"
# The integration branch: the one ref this installer builds and binds, by the
# fleet's fork convention. Per-PR branches live beside it and are never moved
# by an install.
CSWAP_BRANCH="integration"
CSWAP_FORK_URL="${AGENTUSAGE_CSWAP_FORK_URL:-https://github.com/possibilities/claude-swap.git}"
CSWAP_UPSTREAM_REMOTE="origin"
CSWAP_UPSTREAM_BRANCH="main"
FORK_LOG="${AGENTUSAGE_FORK_LOG:-$HOME/.local/state/agentusage/fork-rebase.log}"

status=0

# ── carrying the install branch forward ─────────────────────────────────────
# Upstream keeps moving; a fork pinned to its own main quietly stops receiving
# bugfixes and drifts until its open PRs no longer apply. Every install tries to
# replay our patches onto current upstream — but never at the cost of the build
# that already works.
#
# ONE branch is the integration branch — named `integration`, by the fleet's
# fork convention: every patch we carry, merged, and the only ref this installer
# ever builds and binds. It is what gets rebased here. A patch also offered
# upstream lives on its own branch, and rebasing the integration branch does NOT
# move it — keeping an open PR mergeable is a separate operation against a
# different audience, and conflating the two would force-push someone else's
# review context as a side effect of an install.
#
# The rebase happens in a scratch worktree, so the bound checkout is never left
# mid-rebase or dirty, and the live branch is repointed only after the rebase,
# the project's own CI gate, and the push have all succeeded. Any failure at any
# step leaves the previously bound version bound and tells the human: a fork
# that has silently stopped tracking upstream is exactly the condition this
# exists to surface, so it must never fail quietly.

notify_fork() {
    local title="$1" message="$2"
    printf '%s: %s\n' "${title}" "${message}" >&2
    mkdir -p "$(dirname "${FORK_LOG}")"
    printf '%s  %s: %s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${title}" "${message}" >>"${FORK_LOG}"
    # A banner that never renders must not be the only record — the log above is
    # written first and unconditionally. `-group` replaces a previous notice in
    # place rather than stacking one per install.
    command -v terminal-notifier >/dev/null 2>&1 || return 0
    terminal-notifier -title "${title}" -message "${message}" \
        -group agentusage-fork-rebase >/dev/null 2>&1 || true
}

# Replay `branch` onto `remote/upstream_branch`, gate it, publish it, and rebind
# the checkout to the result. Returns 0 when there was nothing to do or the
# whole sequence succeeded, 1 when the human needs to look. The caller's
# existing ff-only convergence must already have run, so HEAD is the fork's
# published tip and the tree is clean.
rebase_fork_onto_upstream() {
    local checkout="$1" branch="$2" remote="$3" upstream_branch="$4" label="$5"
    shift 5
    local upstream_ref="${remote}/${upstream_branch}"

    if ! git -C "${checkout}" remote get-url "${remote}" >/dev/null 2>&1; then
        printf 'agentusage providers: %s has no %s remote; not tracking upstream.\n' \
            "${label}" "${remote}"
        return 0
    fi
    # An unreachable upstream is a network fact, not a fork problem: keep what
    # works and stay quiet. Only a real divergence failure is worth a banner.
    git -C "${checkout}" fetch --quiet "${remote}" "${upstream_branch}" 2>/dev/null || {
        printf 'agentusage providers: cannot reach %s for %s; keeping the current base.\n' \
            "${upstream_ref}" "${label}"
        return 0
    }
    if git -C "${checkout}" merge-base --is-ancestor "${upstream_ref}" "${branch}"; then
        printf 'agentusage providers: %s already carries %s.\n' "${label}" "${upstream_ref}"
        return 0
    fi

    local behind
    behind="$(git -C "${checkout}" rev-list --count "${branch}..${upstream_ref}")"
    printf 'agentusage providers: %s trails %s by %s; rebasing.\n' \
        "${label}" "${upstream_ref}" \
        "$([ "${behind}" -eq 1 ] && echo '1 commit' || echo "${behind} commits")"

    local work_tree work_branch
    work_tree="$(mktemp -d "${TMPDIR:-/tmp}/${label}-rebase.XXXXXX")"
    work_branch="rebase/${label}-$$"
    rmdir "${work_tree}" 2>/dev/null || true
    git -C "${checkout}" worktree add --quiet -b "${work_branch}" \
        "${work_tree}" "${branch}" || {
        notify_fork "${label} rebase" \
            "could not create a scratch worktree; still on the previous build"
        return 1
    }

    local failure=""
    if ! git -C "${work_tree}" rebase --quiet "${upstream_ref}" >/dev/null 2>&1; then
        git -C "${work_tree}" rebase --abort >/dev/null 2>&1 || true
        failure="conflicts with ${upstream_ref} and needs a hand"
    elif ! ( cd "${work_tree}" && "$@" ); then
        failure="rebased onto ${upstream_ref} but its own test gate failed"
    elif ! git -C "${work_tree}" push --quiet --force-with-lease \
        fork "HEAD:${branch}" >/dev/null 2>&1; then
        failure="passed its gate but could not publish to fork/${branch}"
    fi

    git -C "${checkout}" worktree remove --force "${work_tree}" >/dev/null 2>&1 || true
    git -C "${checkout}" branch -D "${work_branch}" >/dev/null 2>&1 || true

    if [ -n "${failure}" ]; then
        notify_fork "${label} rebase" \
            "${label} ${failure}. Left bound to the previous build; nothing was published."
        return 1
    fi

    # Published history was rewritten, so the local branch no longer fast-forwards
    # onto it. The tree was verified clean and HEAD was the old published tip, so
    # there is nothing here to lose by taking the new one wholesale.
    git -C "${checkout}" fetch --quiet fork "${branch}" || return 1
    git -C "${checkout}" reset --quiet --hard "fork/${branch}" || return 1
    printf 'agentusage providers: %s rebased onto %s and published.\n' \
        "${label}" "${upstream_ref}"
}

# ── claude-swap (cswap) ─────────────────────────────────────────────────────
# The public fork's integration branch is the stable provider contract: it
# carries the capacity metadata and expired-token recovery that agentusage
# consumes. Keep the local checkout exactly on fork/integration so an install
# cannot silently use an upstream-only or unpublished provider build.
install_claude_swap() {
    if ! command -v uv >/dev/null 2>&1; then
        printf 'agentusage providers: uv missing; skipping claude-swap install.\n'
        return 1
    fi
    if [ ! -d "${CSWAP_CHECKOUT}/.git" ]; then
        printf 'agentusage providers: cloning the public claude-swap fork into %s.\n' "${CSWAP_CHECKOUT}"
        mkdir -p "$(dirname "${CSWAP_CHECKOUT}")"
        git clone --quiet --origin fork --branch "${CSWAP_BRANCH}" \
            "${CSWAP_FORK_URL}" "${CSWAP_CHECKOUT}" || return 1
    fi
    local fork_url
    fork_url="$(git -C "${CSWAP_CHECKOUT}" remote get-url fork 2>/dev/null || true)"
    if [ -z "${fork_url}" ]; then
        git -C "${CSWAP_CHECKOUT}" remote add fork "${CSWAP_FORK_URL}" || return 1
    elif [ "${fork_url}" != "${CSWAP_FORK_URL}" ] && \
        [ "${fork_url}" != "git@github.com:possibilities/claude-swap.git" ] && \
        [ "${fork_url}" != "https://github.com/possibilities/claude-swap" ]; then
        printf 'agentusage providers: %s remote fork points at %s, not %s; refusing.\n' \
            "${CSWAP_CHECKOUT}" "${fork_url}" "${CSWAP_FORK_URL}"
        return 1
    fi
    git -C "${CSWAP_CHECKOUT}" fetch --quiet fork "${CSWAP_BRANCH}" || return 1
    if ! git -C "${CSWAP_CHECKOUT}" rev-parse --verify --quiet "refs/heads/${CSWAP_BRANCH}" >/dev/null; then
        git -C "${CSWAP_CHECKOUT}" branch --quiet "${CSWAP_BRANCH}" "fork/${CSWAP_BRANCH}" || return 1
    fi
    local current
    current="$(git -C "${CSWAP_CHECKOUT}" rev-parse --abbrev-ref HEAD)"
    if [ -n "$(git -C "${CSWAP_CHECKOUT}" status --porcelain)" ]; then
        printf 'agentusage providers: %s has local changes on %s; refusing to install them.\n' \
            "${CSWAP_CHECKOUT}" "${current}"
        return 1
    fi
    if [ "${current}" != "${CSWAP_BRANCH}" ]; then
        git -C "${CSWAP_CHECKOUT}" checkout --quiet "${CSWAP_BRANCH}" || return 1
    fi
    git -C "${CSWAP_CHECKOUT}" merge --quiet --ff-only "fork/${CSWAP_BRANCH}" || {
        printf 'agentusage providers: %s@%s cannot fast-forward to fork/%s; refusing.\n' \
            "${CSWAP_CHECKOUT}" "${CSWAP_BRANCH}" "${CSWAP_BRANCH}"
        return 1
    }
    # HEAD is now the fork's published tip on a clean tree — the precondition the
    # rebase needs. Its own CI gate is the bar: `uv sync --locked && uv run
    # pytest`, the two steps .github/workflows/ci.yml runs. A failure here is
    # reported, never fatal: the checkout stays exactly where this line left it.
    rebase_fork_onto_upstream "${CSWAP_CHECKOUT}" "${CSWAP_BRANCH}" \
        "${CSWAP_UPSTREAM_REMOTE}" "${CSWAP_UPSTREAM_BRANCH}" "claude-swap" \
        bash -c 'uv sync --locked && uv run pytest' || true
    if [ "$(git -C "${CSWAP_CHECKOUT}" rev-parse HEAD)" != \
        "$(git -C "${CSWAP_CHECKOUT}" rev-parse "fork/${CSWAP_BRANCH}")" ]; then
        printf 'agentusage providers: %s@%s has unpublished commits; refusing to install them.\n' \
            "${CSWAP_CHECKOUT}" "${CSWAP_BRANCH}"
        return 1
    fi
    printf 'agentusage providers: installing claude-swap from %s@%s.\n' "${CSWAP_CHECKOUT}" "${CSWAP_BRANCH}"
    uv tool install --force "${CSWAP_CHECKOUT}" >/dev/null || return 1
    command -v cswap >/dev/null 2>&1 || {
        printf 'agentusage providers: cswap did not land on PATH (is %s on PATH?).\n' "${BIN_DIR}"
        return 1
    }
    printf 'agentusage providers: cswap %s ready.\n' "$(cswap --version 2>/dev/null | tail -1)"
}

install_claude_swap || status=1

exit "${status}"
