import { CADDYFILE_CONF_D_IMPORT_LINE, XUI_SYSTEMD } from "./setupPhases";

export type TeardownPhaseId =
  | "stop_xui"
  | "remove_xui_install"
  | "stop_caddy"
  | "remove_caddy_site"
  | "trim_caddyfile_import"
  | "purge_caddy"
  | "remove_caddy_apt_wiring";

export type TeardownPhase = {
  id: TeardownPhaseId;
  title: string;
  script: string;
};

const CADDY_SITE_FILE = "/etc/caddy/conf.d/vpn-manager-3x-ui.caddy";
const CADDY_APT_LIST = "/etc/apt/sources.list.d/caddy-stable.list";
const CADDY_KEYRING = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg";

export function buildTeardownPhases(): TeardownPhase[] {
  const stopXui: TeardownPhase = {
    id: "stop_xui",
    title: "Stop and disable 3x-ui (systemd)",
    script: `set -euo pipefail
systemctl disable --now ${XUI_SYSTEMD} 2>/dev/null || true
rm -f /etc/systemd/system/x-ui.service
systemctl daemon-reload
`,
  };

  const removeXui: TeardownPhase = {
    id: "remove_xui_install",
    title: "Remove 3x-ui installation directory",
    script: `set -euo pipefail
rm -rf /usr/local/x-ui
`,
  };

  const stopCaddy: TeardownPhase = {
    id: "stop_caddy",
    title: "Stop Caddy before package and config changes",
    script: `set -euo pipefail
systemctl stop caddy 2>/dev/null || true
`,
  };

  const removeSite: TeardownPhase = {
    id: "remove_caddy_site",
    title: "Remove VPN Manager Caddy site fragment",
    script: `set -euo pipefail
rm -f ${CADDY_SITE_FILE}
`,
  };

  const trimCaddyfile: TeardownPhase = {
    id: "trim_caddyfile_import",
    title: "Remove conf.d import line from main Caddyfile if present",
    script: `set -euo pipefail
if test -f /etc/caddy/Caddyfile; then
  LINE=${JSON.stringify(CADDYFILE_CONF_D_IMPORT_LINE)}
  TMP=$(mktemp)
  awk -v line="$LINE" '
    $0 == line && !removed { removed=1; next }
    { print }
  ' /etc/caddy/Caddyfile > "$TMP"
  mv "$TMP" /etc/caddy/Caddyfile
fi
`,
  };

  const purgeCaddy: TeardownPhase = {
    id: "purge_caddy",
    title: "Purge Caddy package",
    script: `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y caddy 2>/dev/null || true
`,
  };

  const removeApt: TeardownPhase = {
    id: "remove_caddy_apt_wiring",
    title: "Remove Caddy stable apt source and keyring",
    script: `set -euo pipefail
rm -f ${CADDY_APT_LIST} ${CADDY_KEYRING}
`,
  };

  return [stopXui, removeXui, stopCaddy, removeSite, trimCaddyfile, purgeCaddy, removeApt];
}
