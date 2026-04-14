import { Address4, Address6, AddressError } from "ip-address";

const RESERVED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

const RESERVED_V6 = ["::/128", "::1/128", "fe80::/10", "fc00::/7", "ff00::/8", "2001:db8::/32"] as const;

const FQDN_RE = /^([a-zA-Z0-9](-*[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/;

export function isFqdnPanel(value: string): boolean {
  return FQDN_RE.test(value);
}

function tryParseAddress(value: string): Address4 | Address6 | null {
  const v = value.trim();
  if (!v) return null;
  const looksV6 = v.includes(":");
  try {
    return looksV6 ? new Address6(v) : new Address4(v);
  } catch (e) {
    if (e instanceof AddressError) return null;
    throw e;
  }
}

function isReservedIp(addr: Address4 | Address6): boolean {
  const list = addr.v4 ? RESERVED_V4 : RESERVED_V6;
  for (const cidr of list) {
    const net = addr.v4 ? new Address4(cidr) : new Address6(cidr);
    if (addr.isInSubnet(net)) return true;
  }
  return false;
}

/** True only for global unicast public literals (no DNS lookup). */
export function isPublicIpLiteral(value: string): boolean {
  const addr = tryParseAddress(value);
  if (!addr) return false;
  if (!addr.isCorrect()) return false;
  return !isReservedIp(addr);
}

/** Normalize IP literals for storage (IPv6 uses compressed form from the library). */
export function normalizeIpLiteral(value: string): string {
  const addr = tryParseAddress(value);
  if (!addr) throw new Error("normalizeIpLiteral: not a valid IP");
  return addr.correctForm();
}

export type ResolvePanelHostnameResult =
  | { ok: true; panel: string }
  | { ok: false; message: string };

/**
 * `panel` is the explicit panel from the request or merged DB value (empty = missing).
 * `host` is the SSH host (trimmed by caller recommended).
 */
export function resolvePanelHostname(input: { host: string; panel: string }): ResolvePanelHostnameResult {
  const h = input.host.trim();
  const p = input.panel.trim();
  if (p !== "") {
    if (isPublicIpLiteral(p)) return { ok: true, panel: normalizeIpLiteral(p) };
    if (isFqdnPanel(p)) return { ok: true, panel: p };
    return { ok: false, message: "panelHostname must be a valid FQDN or a public IP address." };
  }
  if (isPublicIpLiteral(h)) return { ok: true, panel: normalizeIpLiteral(h) };
  return {
    ok: false,
    message: "panelHostname is required unless IP or Host is a public IP address.",
  };
}

/** Caddy site address key (first token of site block, before `{`). */
export function caddySiteAddressKey(panel: string): string {
  if (isPublicIpLiteral(panel)) {
    const norm = normalizeIpLiteral(panel);
    return norm.includes(":") ? `[${norm}]` : norm;
  }
  return panel;
}

/** Host portion for https URL (IPv6 bracketed). */
export function httpsUrlHost(panel: string): string {
  if (isPublicIpLiteral(panel)) {
    const norm = normalizeIpLiteral(panel);
    return norm.includes(":") ? `[${norm}]` : norm;
  }
  return panel;
}
