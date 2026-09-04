#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf '%s\n' 'Usage: scripts/install.sh --install|--dry-run|--help'
}

case "${1:---help}" in
  --help|-h) usage; exit 0 ;;
  --install) DRY=0 ;;
  --dry-run) DRY=1 ;;
  *) usage >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BUN="${AGENTUSAGE_INSTALL_BUN:-$(command -v bun || true)}"
# A floor, not a pin, matching engines.bun: the wrapper written below execs
# whatever bun lives at this path, so an exact match here would assert a
# version it cannot keep past the next upgrade.
[[ -n "$BUN" ]] || { printf 'install: Bun >= 1.3.14 is required\n' >&2; exit 1; }
BUN_VERSION="$("$BUN" --version)"
[[ "$(printf '%s\n%s\n' 1.3.14 "$BUN_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == 1.3.14 ]] ||
  { printf 'install: Bun >= 1.3.14 is required (found %s)\n' "$BUN_VERSION" >&2; exit 1; }
BIN_DIR="${AGENTUSAGE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTUSAGE_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentusage}"
RECEIPT="$STATE_DIR/install-receipt"
LOG_PATH="$STATE_DIR/observer.log"

# This installer ships the one public binary; the agentusage.observer launch
# agent belongs to AgentStart, which owns every fleet service
# (~/code/agentstart/config/launchd/). Installing the service here as well
# would give one service two owners racing to render it.

if (( DRY )); then
  printf 'would install %s in %s and remove an owned legacy agentusaged wrapper\n' agentusage "$BIN_DIR"
  exit 0
fi

# The directly-owned provider hook (cswap via uv) runs first; best-effort —
# agentusage renders provider absence honestly rather than failing to install.
# codex-swap and grok-swap are not here: each ships its own installer, which
# AgentStart runs.
if [[ "${AGENTUSAGE_SKIP_PROVIDERS:-0}" != 1 ]]; then
  bash "$ROOT/scripts/install-providers.sh" || \
    printf 'install: provider provisioning incomplete (see above); continuing.\n'
fi

mkdir -p "$BIN_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR"
legacy="$BIN_DIR/agentusaged"
if [[ -e "$legacy" ]]; then
  [[ -f "$legacy" && ! -L "$legacy" ]] || { printf 'install: refusing unsafe legacy wrapper %s\n' "$legacy" >&2; exit 1; }
  grep -q '^# agentusage-installer-owned:v1$' "$legacy" || { printf 'install: refusing foreign legacy wrapper %s\n' "$legacy" >&2; exit 1; }
fi
target="$BIN_DIR/agentusage"
temporary="$target.tmp.$$"
printf '#!/usr/bin/env bash\n# agentusage-installer-owned:v1\nexec %q %q "$@"\n' "$BUN" "$ROOT/src/cli.ts" >"$temporary"
chmod 755 "$temporary"
mv -f "$temporary" "$target"

if [[ -e "$legacy" ]]; then
  rm -f "$legacy"
fi

printf 'agentusage-installer-owned:v1\nroot=%s\nbin=%s\nlog=%s\n' \
  "$ROOT" "$BIN_DIR" "$LOG_PATH" >"$RECEIPT"
chmod 600 "$RECEIPT"
printf 'installed agentusage commands in %s\n' "$BIN_DIR"
printf 'the agentusage.observer service is installed by AgentStart: %s\n' \
  "$HOME/code/agentstart/scripts/install-launchagents --install"
