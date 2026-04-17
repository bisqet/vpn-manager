import { appendAgentSessionLog } from "../debug/agentDebugLog";

export type ChainClientAccessResult = { vlessShareLink: string; subscriptionUrl: string };

export type ProvisionChainClientAccessInput = {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  inboundBody: Record<string, unknown>;
  fetchFn?: typeof fetch;
};

export class PanelRequestError extends Error {
  readonly panelMessage: string;

  constructor(panelMessage: string) {
    super(panelMessage);
    this.name = "PanelRequestError";
    this.panelMessage = panelMessage;
  }
}

/** Trim and ensure a trailing slash for relative URL resolution. */
export function panelBaseForProvision(panelBaseUrl: string): string {
  const trimmed = panelBaseUrl.trim();
  if (trimmed === "") return "/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function panelTlsInsecureEnvEnabled(): boolean {
  const v = process.env.VPN_MANAGER_PANEL_TLS_INSECURE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * When `VPN_MANAGER_PANEL_TLS_INSECURE` is true/1/yes and the panel URL is `https://...`,
 * run the callback with that HTTPS base first. If it throws with anything other than
 * {@link PanelRequestError} (TLS/connection failures), retry once using the matching `http://` base.
 */
export async function withPanelTlsInsecureHttpFallback<A>(
  panelBaseUrl: string,
  run: (base: string) => Promise<A>,
): Promise<A> {
  const base = panelBaseForProvision(panelBaseUrl);
  if (!panelTlsInsecureEnvEnabled() || !base.startsWith("https://")) {
    return run(base);
  }
  const httpBase = `http://${base.slice("https://".length)}`;
  try {
    return await run(base);
  } catch (e) {
    if (e instanceof PanelRequestError) throw e;
    return await run(httpBase);
  }
}

/**
 * Default subscription path for MHSanaei/3x-ui: `{base}sub/{subId}` (same origin as the panel URL).
 * If an install uses a non-default sub path or host, this may need a panel-derived URL later.
 */
export function buildSubscriptionUrl(panelBaseUrl: string, subId: string): string {
  const base = panelBaseForProvision(panelBaseUrl);
  return new URL(`sub/${encodeURIComponent(subId)}`, base).href;
}

function readSetCookieLines(headers: Headers): string[] {
  const extended = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") return extended.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function extractSessionCookieHeader(setCookieLines: string[]): string {
  for (const line of setCookieLines) {
    const match = /^3x-ui=([^;]+)/.exec(line.trim());
    if (match) return `3x-ui=${match[1]}`;
  }
  return "";
}

export type PanelJson = { success?: boolean; msg?: string; obj?: unknown };

function assertPanelJson(value: unknown): asserts value is PanelJson {
  if (value === null || typeof value !== "object") {
    throw new PanelRequestError("panel returned non-object JSON");
  }
}

async function readPanelJson(response: Response): Promise<PanelJson> {
  if (!response.ok) {
    throw new PanelRequestError(`panel HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PanelRequestError("panel returned non-JSON body");
  }
  assertPanelJson(body);
  return body;
}

function requireSuccess(json: PanelJson, fallbackMessage: string): void {
  if (json.success !== true) {
    throw new PanelRequestError(typeof json.msg === "string" && json.msg !== "" ? json.msg : fallbackMessage);
  }
}

/** Ports already used on the panel (from `GET panel/api/inbounds/list`). */
export async function fetchInboundUsedPorts(input: {
  panelApiBase: string;
  cookieHeader: string;
  fetchFn: typeof fetch;
}): Promise<Set<number>> {
  const url = new URL("panel/api/inbounds/list", input.panelApiBase).href;
  const response = await input.fetchFn(url, {
    method: "GET",
    headers: {
      cookie: input.cookieHeader,
      accept: "application/json",
    },
  });
  const json = await readPanelJson(response);
  requireSuccess(json, "list inbounds failed");
  const used = new Set<number>();
  let rows: unknown = json.obj;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      return used;
    }
  }
  if (!Array.isArray(rows)) return used;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const portRaw = (row as { port?: unknown }).port;
    const port = typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number(portRaw) : NaN;
    if (Number.isFinite(port) && port > 0 && port <= 65535) used.add(Math.trunc(port));
  }
  if (process.env.VPN_MANAGER_AGENT_DEBUG?.trim() === "1") {
    appendAgentSessionLog({
      sessionId: "ac8c04",
      timestamp: Date.now(),
      location: "provisionChainClientAccess.ts:fetchInboundUsedPorts",
      message: "inbounds_list_ports",
      hypothesisId: "H-parse",
      data: {
        usedCount: used.size,
        objKind: typeof json.obj,
        parsedArray: Array.isArray(rows),
      },
    });
  }
  return used;
}

/** Prefer 443, then common alternates, then high ports. */
export function pickFreeListenPort(usedPorts: ReadonlySet<number>): number {
  if (!usedPorts.has(443)) return 443;
  for (let p = 8443; p <= 8999; p++) {
    if (!usedPorts.has(p)) return p;
  }
  for (let p = 30000; p <= 32000; p++) {
    if (!usedPorts.has(p)) return p;
  }
  throw new PanelRequestError("no free listen port found for new inbound");
}

function parseSubIdFromInboundBody(inboundBody: Record<string, unknown>): string {
  const settings = inboundBody.settings;
  if (typeof settings !== "string") {
    throw new PanelRequestError("inboundBody.settings must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(settings);
  } catch {
    throw new PanelRequestError("inboundBody.settings must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("clients" in parsed)) {
    throw new PanelRequestError("inboundBody.settings JSON must include clients");
  }
  const clients = (parsed as { clients?: unknown }).clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new PanelRequestError("inboundBody.settings.clients must be a non-empty array");
  }
  const first = clients[0];
  if (!first || typeof first !== "object" || !("subId" in first)) {
    throw new PanelRequestError("inbound client must include subId");
  }
  const subId = (first as { subId?: unknown }).subId;
  if (typeof subId !== "string" || subId === "") {
    throw new PanelRequestError("client subId must be a non-empty string");
  }
  return subId;
}

function deepFindVlessUri(value: unknown): string | null {
  if (typeof value === "string" && value.startsWith("vless://")) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = deepFindVlessUri(item);
        if (found) return found;
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const found = deepFindVlessUri((value as Record<string, unknown>)[key]);
        if (found) return found;
      }
    }
  }
  return null;
}

type StreamReality = {
  publicKey: string;
  shortId: string;
  sni: string;
  fingerprint: string;
  spiderX: string;
};

function parseRealityFromStreamSettings(streamSettingsJson: string): StreamReality | null {
  let stream: unknown;
  try {
    stream = JSON.parse(streamSettingsJson);
  } catch {
    return null;
  }
  if (!stream || typeof stream !== "object") return null;
  const s = stream as {
    security?: string;
    realitySettings?: {
      shortIds?: string[];
      serverNames?: string[];
      settings?: { publicKey?: string; fingerprint?: string; serverName?: string; spiderX?: string };
    };
  };
  if (s.security !== "reality" || !s.realitySettings) return null;
  const rs = s.realitySettings;
  const settings = rs.settings ?? {};
  const publicKey = typeof settings.publicKey === "string" ? settings.publicKey : "";
  const fingerprint = typeof settings.fingerprint === "string" && settings.fingerprint !== "" ? settings.fingerprint : "chrome";
  const serverName = typeof settings.serverName === "string" && settings.serverName !== "" ? settings.serverName : "";
  const sni =
    serverName !== ""
      ? serverName
      : typeof rs.serverNames?.[0] === "string"
        ? rs.serverNames[0]!
        : "";
  const shortId = typeof rs.shortIds?.[0] === "string" ? rs.shortIds[0]! : "";
  const spiderX = typeof settings.spiderX === "string" ? settings.spiderX : "/";
  if (!publicKey || !shortId || !sni) return null;
  return { publicKey, shortId, sni, fingerprint, spiderX };
}

function parseClientFromSettings(settingsJson: string): { id: string; flow: string } | null {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (!settings || typeof settings !== "object") return null;
  const clients = (settings as { clients?: unknown }).clients;
  if (!Array.isArray(clients) || clients.length === 0) return null;
  const c = clients[0];
  if (!c || typeof c !== "object") return null;
  const id = (c as { id?: unknown }).id;
  const flow = (c as { flow?: unknown }).flow;
  if (typeof id !== "string" || typeof flow !== "string") return null;
  return { id, flow };
}

function buildVlessTcpRealityUri(input: {
  uuid: string;
  host: string;
  port: number;
  flow: string;
  remark: string;
  reality: StreamReality;
}): string {
  const params = new URLSearchParams({
    encryption: "none",
    flow: input.flow,
    security: "reality",
    pbk: input.reality.publicKey,
    fp: input.reality.fingerprint,
    sni: input.reality.sni,
    sid: input.reality.shortId,
    spx: input.reality.spiderX === "" ? "/" : input.reality.spiderX,
    type: "tcp",
    headerType: "none",
  });
  const fragment = encodeURIComponent(input.remark);
  return `vless://${input.uuid}@${input.host}:${input.port}?${params.toString()}#${fragment}`;
}

function panelHostname(panelBaseUrl: string): string {
  try {
    return new URL(panelBaseUrl).hostname;
  } catch {
    throw new PanelRequestError("panelBaseUrl must be a valid absolute URL");
  }
}

export function resolveVlessShareLink(input: {
  panelBaseUrl: string;
  inboundBody: Record<string, unknown>;
  addJson: PanelJson;
}): string {
  const fromResponse = deepFindVlessUri(input.addJson.obj);
  if (fromResponse) return fromResponse;

  const obj = input.addJson.obj;
  if (!obj || typeof obj !== "object") {
    throw new PanelRequestError("panel add inbound response missing obj");
  }
  const record = obj as Record<string, unknown>;
  const portRaw = record.port;
  const port = typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number(portRaw) : NaN;
  if (!Number.isFinite(port) || port <= 0) {
    throw new PanelRequestError("panel inbound obj missing valid port");
  }

  const settingsJson =
    typeof record.settings === "string"
      ? record.settings
      : typeof input.inboundBody.settings === "string"
        ? input.inboundBody.settings
        : "";
  const streamJson =
    typeof record.streamSettings === "string"
      ? record.streamSettings
      : typeof input.inboundBody.streamSettings === "string"
        ? input.inboundBody.streamSettings
        : "";

  const client = settingsJson ? parseClientFromSettings(settingsJson) : null;
  if (!client) {
    throw new PanelRequestError("unable to read client uuid/flow from settings");
  }

  const reality = streamJson ? parseRealityFromStreamSettings(streamJson) : null;
  if (!reality) {
    throw new PanelRequestError("unable to read REALITY material from streamSettings");
  }

  const remark = typeof input.inboundBody.remark === "string" ? input.inboundBody.remark : "vless";

  return buildVlessTcpRealityUri({
    uuid: client.id,
    host: panelHostname(input.panelBaseUrl),
    port,
    flow: client.flow,
    remark,
    reality,
  });
}

export async function provisionChainClientAccess(
  input: ProvisionChainClientAccessInput,
): Promise<ChainClientAccessResult> {
  return withPanelTlsInsecureHttpFallback(input.panelBaseUrl, async (base) => {
    const fetchFn = input.fetchFn ?? fetch;

    const loginUrl = new URL("login", base).href;
    const loginBody = new URLSearchParams({
      username: input.adminUsername,
      password: input.adminPassword,
      twoFactorCode: "",
    });

    const loginResponse = await fetchFn(loginUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        accept: "application/json",
      },
      body: loginBody.toString(),
    });

    const scLines = readSetCookieLines(loginResponse.headers);

    const loginJson = await readPanelJson(loginResponse);
    requireSuccess(loginJson, "login failed");

    const cookieHeader = extractSessionCookieHeader(scLines);
    if (!cookieHeader) {
      throw new PanelRequestError("login succeeded but session cookie (3x-ui) was not set");
    }

    const usedPorts = await fetchInboundUsedPorts({ panelApiBase: base, cookieHeader, fetchFn });
    const listenPort = pickFreeListenPort(usedPorts);
    const inboundBody: Record<string, unknown> = { ...input.inboundBody, port: listenPort };

    const addUrl = new URL("panel/api/inbounds/add", base).href;
    const addResponse = await fetchFn(addUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify(inboundBody),
    });

    const addJson = await readPanelJson(addResponse);
    requireSuccess(addJson, "add inbound failed");

    const subId = parseSubIdFromInboundBody(inboundBody);
    const subscriptionUrl = buildSubscriptionUrl(base, subId);
    const vlessShareLink = resolveVlessShareLink({
      panelBaseUrl: base,
      inboundBody,
      addJson,
    });

    return { vlessShareLink, subscriptionUrl };
  });
}
