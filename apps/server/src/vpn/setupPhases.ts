import { buildPanelLoopbackHttpUrl } from "../net/panelAddress";

/**
 * Ordered remote setup phases for 3x-ui on Ubuntu 24 (panel bound to loopback).
 * Scripts assume root/sudo; admin credentials must be [a-zA-Z0-9]+ only (no shell metacharacters).
 * @see https://github.com/MHSanaei/3x-ui — x-ui binary: listenIP via `setting -listenIP`
 */

export type SetupPhaseId = "preflight" | "ufw" | "install_xui" | "configure_xui" | "verify";

export type SetupPhase = {
  id: SetupPhaseId;
  title: string;
  script: string;
};

export const PLACEHOLDER_ADMIN_USER = "<GENERATED_ADMIN_USERNAME>";
export const PLACEHOLDER_ADMIN_PASS = "<GENERATED_ADMIN_PASSWORD>";
export const PLACEHOLDER_WEB_BASE_PATH = "<GENERATED_WEB_BASE_PATH>";
export const PLACEHOLDER_SUB_PATH_DB = "<GENERATED_SUBSCRIPTION_SUB_PATH>";
export const PLACEHOLDER_SUB_JSON_PATH_DB = "<GENERATED_SUBSCRIPTION_JSON_PATH>";

export const XUI_BIN = "/usr/local/x-ui/x-ui";
export const XUI_SYSTEMD = "x-ui";

export type SetupPhaseContext = {
  xuiLocalPort: number;
  adminUsername: string;
  adminPassword: string;
  webBasePath: string;
  subPathDb: string;
  subJsonPathDb: string;
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

export function buildSetupPhases(ctx: SetupPhaseContext): SetupPhase[] {
  const { xuiLocalPort, adminUsername, adminPassword, webBasePath, subPathDb, subJsonPathDb } = ctx;
  const loopbackUrl = buildPanelLoopbackHttpUrl(xuiLocalPort, webBasePath);
  if (loopbackUrl === null) throw new Error("buildSetupPhases: loopback panel URL unexpectedly empty");

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
    title: "Configure 3x-ui (credentials, localhost bind, web base path, subscription URI paths)",
    script: `set -euo pipefail
${XUI_BIN} setting -username '${adminUsername}' -password '${adminPassword}' -port ${xuiLocalPort} -webBasePath '${webBasePath}' -listenIP 127.0.0.1
systemctl restart ${XUI_SYSTEMD}
sleep 2
systemctl is-active --quiet ${XUI_SYSTEMD}
XUI_DB=/etc/x-ui/x-ui.db
test -f "$XUI_DB"
command -v sqlite3 >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sqlite3; }
systemctl stop ${XUI_SYSTEMD}
sub_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subPathDb}' WHERE key='subPath'; SELECT changes();")
json_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subJsonPathDb}' WHERE key='subJsonPath'; SELECT changes();")
test "$sub_changes" = "1"
test "$json_changes" = "1"
systemctl start ${XUI_SYSTEMD}
sleep 2
systemctl is-active --quiet ${XUI_SYSTEMD}
`,
  };

  const verify: SetupPhase = {
    id: "verify",
    title: "Verify (systemd + panel on loopback)",
    script: `set -euo pipefail
systemctl is-active --quiet ${XUI_SYSTEMD}
curl -fsS -o /dev/null "${loopbackUrl}"
`,
  };

  return [preflight, ufw, installXui, configureXui, verify];
}
