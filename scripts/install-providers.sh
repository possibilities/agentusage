#!/usr/bin/env bash
# Best-effort provisioning of the two provider CLIs agentusage consumes.
# Safe to re-run; each step skips or refuses rather than clobbering foreign
# state. Failures here never block agentusage's own install.
set -uo pipefail

BIN_DIR="${AGENTUSAGE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
CSWAP_CHECKOUT="${AGENTUSAGE_CSWAP_CHECKOUT:-$HOME/src/claude-swap}"
CSWAP_BRANCH="integration/agentusage"
CSWAP_FORK_URL="https://github.com/possibilities/claude-swap.git"
CSWAP_UPSTREAM_URL="https://github.com/realiti4/claude-swap.git"
CODEX_SWAP_ROOT="${AGENTUSAGE_CODEX_SWAP_ROOT:-$HOME/code/codex-swap}"
SHIM_MARKER="agentusage-installer-owned:v1"

status=0

# ── claude-swap (cswap) ─────────────────────────────────────────────────────
# The integration branch is current upstream plus the two open PRs keeper
# depended on: #169 account-capacity-metadata and #166 recover-expired-token.
# Refreshing the branch onto a newer upstream is a manual act (see README);
# this installer only installs what the checkout already holds.
install_claude_swap() {
    if ! command -v uv >/dev/null 2>&1; then
        printf 'agentusage providers: uv missing; skipping claude-swap install.\n'
        return 1
    fi
    if [ ! -d "${CSWAP_CHECKOUT}/.git" ]; then
        printf 'agentusage providers: cloning claude-swap upstream into %s.\n' "${CSWAP_CHECKOUT}"
        git clone --quiet "${CSWAP_UPSTREAM_URL}" "${CSWAP_CHECKOUT}" || return 1
    fi
    if ! git -C "${CSWAP_CHECKOUT}" remote get-url fork >/dev/null 2>&1; then
        git -C "${CSWAP_CHECKOUT}" remote add fork "${CSWAP_FORK_URL}" || return 1
    fi
    if ! git -C "${CSWAP_CHECKOUT}" rev-parse --verify --quiet "${CSWAP_BRANCH}" >/dev/null; then
        git -C "${CSWAP_CHECKOUT}" fetch --quiet fork "${CSWAP_BRANCH}" || return 1
        git -C "${CSWAP_CHECKOUT}" branch --quiet "${CSWAP_BRANCH}" "fork/${CSWAP_BRANCH}" || return 1
    fi
    local current
    current="$(git -C "${CSWAP_CHECKOUT}" rev-parse --abbrev-ref HEAD)"
    if [ "${current}" != "${CSWAP_BRANCH}" ]; then
        if ! git -C "${CSWAP_CHECKOUT}" diff --quiet || ! git -C "${CSWAP_CHECKOUT}" diff --cached --quiet; then
            printf 'agentusage providers: %s has local changes on %s; refusing to switch branches.\n' \
                "${CSWAP_CHECKOUT}" "${current}"
            return 1
        fi
        git -C "${CSWAP_CHECKOUT}" checkout --quiet "${CSWAP_BRANCH}" || return 1
    fi
    printf 'agentusage providers: installing claude-swap from %s@%s.\n' "${CSWAP_CHECKOUT}" "${CSWAP_BRANCH}"
    uv tool install --force --from "${CSWAP_CHECKOUT}" claude-swap >/dev/null || return 1
    command -v cswap >/dev/null 2>&1 || {
        printf 'agentusage providers: cswap did not land on PATH (is %s on PATH?).\n' "${BIN_DIR}"
        return 1
    }
    printf 'agentusage providers: cswap %s ready.\n' "$(cswap --version 2>/dev/null | tail -1)"
}

# ── codex-swap ──────────────────────────────────────────────────────────────
# codex-swap has no installer of its own yet; until it does, a source shim
# runs it via Node >= 24 type stripping so the checkout is always current.
install_codex_swap() {
    if [ ! -f "${CODEX_SWAP_ROOT}/src/cli/main.ts" ]; then
        printf 'agentusage providers: no codex-swap checkout at %s; skipping.\n' "${CODEX_SWAP_ROOT}"
        return 1
    fi
    local node_bin
    node_bin="$(command -v node || true)"
    if [ -z "${node_bin}" ]; then
        printf 'agentusage providers: node missing; skipping codex-swap shim.\n'
        return 1
    fi
    local major
    major="$("${node_bin}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "${major}" -lt 24 ]; then
        printf 'agentusage providers: node %s < 24; skipping codex-swap shim.\n' "${major}"
        return 1
    fi
    local target="${BIN_DIR}/codex-swap"
    if [ -e "${target}" ] && ! grep -Fq "${SHIM_MARKER}" "${target}" 2>/dev/null; then
        printf 'agentusage providers: %s exists and is not ours; leaving it alone.\n' "${target}"
        return 0
    fi
    mkdir -p "${BIN_DIR}"
    local temporary="${target}.tmp.$$"
    printf '#!/usr/bin/env bash\n# %s codex-swap source shim\nexec %q %q "$@"\n' \
        "${SHIM_MARKER}" "${node_bin}" "${CODEX_SWAP_ROOT}/src/cli/main.ts" >"${temporary}"
    chmod 755 "${temporary}"
    mv -f "${temporary}" "${target}"
    printf 'agentusage providers: codex-swap shim -> %s.\n' "${CODEX_SWAP_ROOT}"
}

install_claude_swap || status=1
install_codex_swap || status=1

exit "${status}"
