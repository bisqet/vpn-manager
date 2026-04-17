const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const ANCHOR = "Panel Installation Complete";

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

function normalizeHostForCompare(host: string): string {
  let h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  return h.toLowerCase();
}

function extractLineValue(block: string, label: string): string | null {
  const re = new RegExp(`^\\s*${escapeRegExp(label)}:\\s*(.+)$`, "m");
  const m = block.match(re);
  if (!m) return null;
  return m[1].trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathnameToSingleSegment(pathname: string): string | null {
  let p = pathname;
  if (p.endsWith("/") && p.length > 1) {
    p = p.slice(0, -1);
  }
  if (!p.startsWith("/")) {
    return null;
  }
  const rest = p.slice(1);
  if (!rest || rest.includes("/")) {
    return null;
  }
  return rest;
}

export function parseInstallShCredentials(
  plainTranscript: string,
  panelHostname: string,
): { adminUsername: string; adminPassword: string; webBasePath: string; panelPort: number | null } | null {
  const stripped = stripAnsi(plainTranscript);
  if (!stripped.includes(ANCHOR)) {
    return null;
  }

  const anchorIdx = stripped.lastIndexOf(ANCHOR);
  const block = stripped.slice(anchorIdx);

  const adminUsername = extractLineValue(block, "Username");
  const adminPassword = extractLineValue(block, "Password");
  const webBasePath = extractLineValue(block, "WebBasePath");
  const accessUrlRaw = extractLineValue(block, "Access URL");

  if (!adminUsername || !adminPassword || !webBasePath || !accessUrlRaw) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(accessUrlRaw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  const urlHost = url.hostname;
  if (normalizeHostForCompare(urlHost) !== normalizeHostForCompare(panelHostname)) {
    return null;
  }

  const pathSegment = pathnameToSingleSegment(url.pathname);
  if (pathSegment === null || pathSegment !== webBasePath) {
    return null;
  }

  const portStr = url.port;
  let panelPort: number | null = null;
  if (portStr !== "") {
    const p = Number(portStr);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return null;
    }
    panelPort = p;
  }

  return { adminUsername, adminPassword, webBasePath, panelPort };
}
