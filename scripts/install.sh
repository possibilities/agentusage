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
LAUNCH_AGENTS_DIR="${AGENTUSAGE_INSTALL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${AGENTUSAGE_INSTALL_LAUNCHCTL:-launchctl}"
SERVICE_LABEL=agentusage.daemon
SERVICE_DEST="$LAUNCH_AGENTS_DIR/$SERVICE_LABEL.plist"
SERVICE_MARKER='agentusage-installer-owned: agentusage.daemon.v1'
PLIST_SOURCE="$ROOT/system/Library/LaunchAgents/$SERVICE_LABEL.plist"
LOG_PATH="$STATE_DIR/daemon.log"

if (( DRY )); then
  printf 'would install %s and %s in %s, and %s\n' \
    agentusage agentusaged "$BIN_DIR" "$SERVICE_DEST"
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

launchctl_available() {
  [[ "$LAUNCHCTL" != none ]] && command -v "$LAUNCHCTL" >/dev/null 2>&1
}

service_is_owned() {
  [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] &&
    grep -Fq "$SERVICE_MARKER" "$SERVICE_DEST" &&
    grep -Fq "<string>$SERVICE_LABEL</string>" "$SERVICE_DEST"
}

# absent | owned | foreign, decided by the program launchd reports running.
loaded_service_state() {
  local description line
  launchctl_available || { printf absent; return 0; }
  description="$("$LAUNCHCTL" print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null)" ||
    { printf absent; return 0; }
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == "program = $BIN_DIR/agentusaged" ]]; then
      printf owned
      return 0
    fi
  done <<<"$description"
  printf foreign
}

if [[ -e "$SERVICE_DEST" || -L "$SERVICE_DEST" ]] && ! service_is_owned; then
  printf 'install: refusing foreign service %s\n' "$SERVICE_DEST" >&2
  exit 1
fi
if [[ "$(loaded_service_state)" == foreign ]]; then
  printf 'install: refusing to unload foreign service %s\n' "$SERVICE_LABEL" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR"
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"

# The daemon shells cswap (uv shim in BIN_DIR) and codex-swap (source shim in
# BIN_DIR execing an absolute node), so BIN_DIR plus the bun dir cover it;
# pinned env vars below make the provider binaries PATH-independent anyway.
SERVICE_PATH="$(dirname "$BUN"):$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CSWAP_BIN_ABS="$(command -v cswap || printf '%s' cswap)"
CODEX_SWAP_BIN_ABS="$(command -v codex-swap || printf '%s' codex-swap)"

TEMP_PLIST="$(mktemp "$LAUNCH_AGENTS_DIR/.$SERVICE_LABEL.plist.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT
export AGENTUSAGE_RENDER_PROGRAM="$BIN_DIR/agentusaged"
export AGENTUSAGE_RENDER_HOME="$HOME"
export AGENTUSAGE_RENDER_PATH="$SERVICE_PATH"
export AGENTUSAGE_RENDER_LOG="$LOG_PATH"
export AGENTUSAGE_RENDER_CSWAP_BIN="$CSWAP_BIN_ABS"
export AGENTUSAGE_RENDER_CODEX_SWAP_BIN="$CODEX_SWAP_BIN_ABS"
# The single-quoted argument intentionally contains JavaScript template literals.
# shellcheck disable=SC2016
"$BUN" -e '
  const [source, destination] = Bun.argv.slice(-2);
  const escapeXml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("\u0027", "&apos;");
  const replacements = {
    __AGENTUSAGE_PROGRAM__: process.env.AGENTUSAGE_RENDER_PROGRAM,
    __AGENTUSAGE_HOME__: process.env.AGENTUSAGE_RENDER_HOME,
    __AGENTUSAGE_PATH__: process.env.AGENTUSAGE_RENDER_PATH,
    __AGENTUSAGE_LOG__: process.env.AGENTUSAGE_RENDER_LOG,
    __AGENTUSAGE_CSWAP_BIN__: process.env.AGENTUSAGE_RENDER_CSWAP_BIN,
    __AGENTUSAGE_CODEX_SWAP_BIN__: process.env.AGENTUSAGE_RENDER_CODEX_SWAP_BIN,
  };
  let rendered = await Bun.file(source).text();
  for (const [token, value] of Object.entries(replacements)) {
    if (value === undefined) throw new Error(`missing render value for ${token}`);
    rendered = rendered.replaceAll(token, escapeXml(value));
  }
  if (rendered.includes("__AGENTUSAGE_")) throw new Error("unrendered plist token");
  await Bun.write(destination, rendered);
' "$PLIST_SOURCE" "$TEMP_PLIST"
chmod 600 "$TEMP_PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TEMP_PLIST" >/dev/null
fi

# launchd unloads asynchronously, and bootstrapping a label that is still
# tearing down fails with EIO — wait for the unload to be observable before
# publishing and reloading.
unload_owned_service() {
  local waited
  launchctl_available || return 0
  [[ "$(loaded_service_state)" == owned ]] || return 0
  "$LAUNCHCTL" bootout "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
  for waited in $(seq 1 50); do
    [[ "$(loaded_service_state)" == absent ]] && return 0
    sleep 0.1
  done
  printf 'install: service remained loaded after unload: %s\n' "$SERVICE_LABEL" >&2
  return 1
}

unload_owned_service
mv -f "$TEMP_PLIST" "$SERVICE_DEST"
trap - EXIT

printf 'agentusage-installer-owned:v1\nroot=%s\nbin=%s\nlabel=%s\nservice=%s\nlog=%s\n' \
  "$ROOT" "$BIN_DIR" "$SERVICE_LABEL" "$SERVICE_DEST" "$LOG_PATH" >"$RECEIPT"
chmod 600 "$RECEIPT"
printf 'installed agentusage commands in %s\n' "$BIN_DIR"

if launchctl_available; then
  "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$SERVICE_DEST"
  if [[ "$(loaded_service_state)" != owned ]]; then
    printf 'install: loaded service failed ownership verification: %s\n' \
      "$SERVICE_LABEL" >&2
    exit 1
  fi
  printf 'installed and loaded %s\n' "$SERVICE_DEST"
else
  printf 'installed %s (launchctl unavailable; service not loaded)\n' "$SERVICE_DEST"
fi
