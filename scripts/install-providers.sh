#!/usr/bin/env bash
# Best-effort provisioning of the two provider CLIs agentusage consumes.
# Safe to re-run; each step skips or refuses rather than clobbering foreign
# state. Failures here never block agentusage's own install.
set -uo pipefail

BIN_DIR="${AGENTUSAGE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
CSWAP_CHECKOUT="${AGENTUSAGE_CSWAP_CHECKOUT:-$HOME/src/claude-swap}"
CSWAP_BRANCH="main"
CSWAP_FORK_URL="${AGENTUSAGE_CSWAP_FORK_URL:-https://github.com/possibilities/claude-swap.git}"
CODEX_SWAP_ROOT="${AGENTUSAGE_CODEX_SWAP_ROOT:-$HOME/code/codex-swap}"
SHIM_MARKER="agentusage-installer-owned:v1"

status=0

# ── claude-swap (cswap) ─────────────────────────────────────────────────────
# The public fork's main branch is the stable provider contract: it carries the
# capacity metadata and expired-token recovery that agentusage consumes. Keep
# the local checkout exactly on fork/main so an install cannot silently use an
# upstream-only or unpublished provider build.
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
