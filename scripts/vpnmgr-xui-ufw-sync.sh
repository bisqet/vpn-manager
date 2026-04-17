#!/usr/bin/env bash
# Requires bash 4+ (uses mapfile). Target: Linux hosts with ufw + 3x-ui.
set -euo pipefail

# Managed UFW comments must contain this substring (see design spec).
readonly TAG="vpnmgr-xui"
readonly DB_PATH="${VPNMGR_XUI_DB_PATH:-/etc/x-ui/x-ui.db}"

log() { printf '%s\n' "$*" >&2; }

if ! command -v ufw >/dev/null 2>&1; then
  log "vpnmgr-xui-ufw-sync: ufw not installed; skip"
  exit 0
fi

if ufw status 2>/dev/null | grep -qi '^Status:[[:space:]]*inactive'; then
  log "vpnmgr-xui-ufw-sync: ufw inactive; skip"
  exit 0
fi

if [ ! -r "$DB_PATH" ]; then
  log "vpnmgr-xui-ufw-sync: cannot read database: $DB_PATH"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "vpnmgr-xui-ufw-sync: sqlite3 not found"
  exit 1
fi

delete_managed() {
  # Delete by rule number from highest to lowest so indices stay valid.
  while true; do
    mapfile -t nums < <(ufw status numbered 2>/dev/null | awk -F'[][]' -v t="$TAG" '
      $0 ~ t {
        n = $2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", n)
        if (n ~ /^[0-9]+$/) print n
      }
    ' | sort -unr)
    if [ "${#nums[@]}" -eq 0 ]; then
      break
    fi
    n="${nums[0]}"
    yes "" | ufw delete "$n" >/dev/null 2>&1 || return 1
  done
}

delete_managed || exit 1

web_port="$(sqlite3 "$DB_PATH" "SELECT value FROM settings WHERE key='webPort' LIMIT 1;" 2>/dev/null || true)"
if [[ "$web_port" =~ ^[0-9]+$ ]] && [ "$web_port" -ge 1 ] && [ "$web_port" -le 65535 ]; then
  ufw allow "${web_port}/tcp" comment "${TAG} panel" >/dev/null
fi

while IFS='|' read -r port proto; do
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || continue
  p="${proto:-vless}"
  p_lc="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  if [ "$p_lc" = "wireguard" ]; then
    ufw allow "${port}/udp" comment "${TAG} inbound ${port} udp" >/dev/null
  else
    ufw allow "${port}/tcp" comment "${TAG} inbound ${port} tcp" >/dev/null
  fi
done < <(sqlite3 -separator '|' "$DB_PATH" \
  "SELECT port, lower(protocol) FROM inbounds WHERE enable = 1 ORDER BY port ASC;")

exit 0
