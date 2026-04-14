import { buildPanelHttpsUrl, caddySiteAddressKey } from "../net/panelAddress";

/**
 * Ordered remote setup phases for 3x-ui + Caddy on Ubuntu 24.
 * Scripts assume root/sudo; admin credentials must be [a-zA-Z0-9]+ only (no shell metacharacters).
 * @see https://github.com/MHSanaei/3x-ui — x-ui binary: listenIP via `setting -listenIP`
 */

export type SetupPhaseId =
  | "preflight"
  | "ufw"
  | "install_xui"
  | "configure_xui"
  | "install_caddy"
  | "configure_caddy"
  | "verify";

export type SetupPhase = {
  id: SetupPhaseId;
  title: string;
  script: string;
};

export const PLACEHOLDER_ADMIN_USER = "<GENERATED_ADMIN_USERNAME>";
export const PLACEHOLDER_ADMIN_PASS = "<GENERATED_ADMIN_PASSWORD>";
export const PLACEHOLDER_WEB_BASE_PATH = "<GENERATED_WEB_BASE_PATH>";

export const XUI_BIN = "/usr/local/x-ui/x-ui";
export const XUI_SYSTEMD = "x-ui";

export type SetupPhaseContext = {
  panelHostname: string;
  acmeEmail: string;
  xuiLocalPort: number;
  adminUsername: string;
  adminPassword: string;
  webBasePath: string;
};

function debianArch(): string {
  return `ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) XUI_ARCH=amd64 ;;
  arm64) XUI_ARCH=arm64 ;;
  armhf) XUI_ARCH=armv7 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac`;
}

const caddyConfPath = "/etc/caddy/conf.d/vpn-manager-3x-ui.caddy";

/**
 * Line included in `/etc/caddy/Caddyfile` so snippet files in `conf.d` load.
 * Setup appends this line when missing; teardown removes one matching line.
 */
export const CADDYFILE_CONF_D_IMPORT_LINE = "import /etc/caddy/conf.d/*.caddy";

export function buildSetupPhases(ctx: SetupPhaseContext): SetupPhase[] {
  const { panelHostname, acmeEmail, xuiLocalPort, adminUsername, adminPassword, webBasePath } = ctx;
  const panelHttpsUrl = buildPanelHttpsUrl(panelHostname, webBasePath);
  if (panelHttpsUrl === null) throw new Error("buildSetupPhases: panelHttpsUrl unexpectedly empty");
  const caddySiteKey = caddySiteAddressKey(panelHostname);

  const preflight: SetupPhase = {
    id: "preflight",
    title: "Preflight (Ubuntu 24, tools)",
    script: `set -euo pipefail
grep -E '^VERSION_ID=' /etc/os-release || true
test "$(. /etc/os-release && echo "$ID")" = "ubuntu" || { echo "Expected Ubuntu"; exit 1; }
VER=$(. /etc/os-release && echo "$VERSION_ID" | tr -d '"')
case "$VER" in
  24.04) ;;
  *) echo "Warning: expected Ubuntu 24.04 LTS, found $VER";;
esac
command -v curl >/dev/null
command -v tar >/dev/null
id
`,
  };

  const ufw: SetupPhase = {
    id: "ufw",
    title: "Firewall (ufw: SSH, HTTP, HTTPS)",
    script: `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw
ufw default deny incoming
ufw allow OpenSSH || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
`,
  };

  const installXui: SetupPhase = {
    id: "install_xui",
    title: "Install 3x-ui (release tarball + systemd)",
    script: `set -euo pipefail
${debianArch()}
TAG=$(curl -fsSL "https://api.github.com/repos/MHSanaei/3x-ui/releases/latest" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -1)
test -n "$TAG"
TMP=$(mktemp -d)
cd "$TMP"
curl -fsSL -o x-ui.tgz "https://github.com/MHSanaei/3x-ui/releases/download/\${TAG}/x-ui-linux-\${XUI_ARCH}.tar.gz"
tar -xzf x-ui.tgz
chmod +x x-ui/x-ui x-ui/bin/xray-linux-* 2>/dev/null || chmod +x x-ui/x-ui x-ui/bin/*
mkdir -p /usr/local/
rm -rf /usr/local/x-ui
mv "$TMP/x-ui" /usr/local/x-ui
cp -f /usr/local/x-ui/x-ui.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ${XUI_SYSTEMD}
systemctl restart ${XUI_SYSTEMD} || true
`,
  };

  const configureXui: SetupPhase = {
    id: "configure_xui",
    title: "Configure 3x-ui (credentials, localhost bind, web base path)",
    script: `set -euo pipefail
${XUI_BIN} setting -username '${adminUsername}' -password '${adminPassword}' -port ${xuiLocalPort} -webBasePath '${webBasePath}' -listenIP 127.0.0.1
systemctl restart ${XUI_SYSTEMD}
sleep 2
systemctl is-active --quiet ${XUI_SYSTEMD}
`,
  };

  const installCaddy: SetupPhase = {
    id: "install_caddy",
    title: "Install Caddy (apt, official repo)",
    script: `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
`,
  };

  const configureCaddy: SetupPhase = {
    id: "configure_caddy",
    title: "Configure Caddy (HTTPS reverse proxy to localhost panel)",
    script: `set -euo pipefail
mkdir -p /etc/caddy/conf.d
cat > ${caddyConfPath} <<CADDY_EOF
{
\temail ${acmeEmail}
}
${caddySiteKey} {
\tencode gzip
\treverse_proxy 127.0.0.1:${xuiLocalPort}
}
CADDY_EOF
LINE='${CADDYFILE_CONF_D_IMPORT_LINE}'
if ! grep -qF "$LINE" /etc/caddy/Caddyfile 2>/dev/null; then
  printf '%s\\n' "$LINE" >> /etc/caddy/Caddyfile
fi
caddy fmt --overwrite ${caddyConfPath} 2>/dev/null || true
systemctl enable caddy
systemctl restart caddy
sleep 2
systemctl is-active --quiet caddy
`,
  };

  const verify: SetupPhase = {
    id: "verify",
    title: "Verify (systemd + HTTPS)",
    script: `set -euo pipefail
systemctl is-active --quiet ${XUI_SYSTEMD}
systemctl is-active --quiet caddy
curl -fsS -g -o /dev/null "${panelHttpsUrl}"
`,
  };

  return [preflight, ufw, installXui, configureXui, installCaddy, configureCaddy, verify];
}
