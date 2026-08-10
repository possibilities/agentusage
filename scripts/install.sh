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
LOG_PATH="$STATE_DIR/daemon.log"

# This installer ships the binaries; the agentusage.daemon launch agent that
# supervises agentusaged belongs to Agentdots, which owns every fleet service
# (~/code/agentdots/config/launchd/). Installing the daemon here as well would
# give one service two owners racing to render it.

if (( DRY )); then
  printf 'would install %s and %s in %s\n' agentusage agentusaged "$BIN_DIR"
  exit 0
fi

# Provider CLIs first (cswap via uv, codex-swap source shim); best-effort —
# agentusage renders provider absence honestly rather than failing to install.
if [[ "${AGENTUSAGE_SKIP_PROVIDERS:-0}" != 1 ]]; then
  bash "$ROOT/scripts/install-providers.sh" || \
    printf 'install: provider provisioning incomplete (see above); continuing.\n'
fi

mkdir -p "$BIN_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR"
for name in agentusage agentusaged; do
  source="$ROOT/src/$([[ "$name" == agentusage ]] && printf cli || printf daemon).ts"
  target="$BIN_DIR/$name"
  temporary="$target.tmp.$$"
  printf '#!/usr/bin/env bash\n# agentusage-installer-owned:v1\nexec %q %q "$@"\n' "$BUN" "$source" >"$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$target"
done

printf 'agentusage-installer-owned:v1\nroot=%s\nbin=%s\nlog=%s\n' \
  "$ROOT" "$BIN_DIR" "$LOG_PATH" >"$RECEIPT"
chmod 600 "$RECEIPT"
printf 'installed agentusage commands in %s\n' "$BIN_DIR"
printf 'the agentusage.daemon service is installed by Agentdots: %s\n' \
  "$HOME/code/agentdots/scripts/install-launchagents --install"
