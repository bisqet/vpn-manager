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

function normalizePanelBaseUrl(panelBaseUrl: string): string {
  const trimmed = panelBaseUrl.trim();
  if (trimmed === "") return "/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Default subscription path for MHSanaei/3x-ui: `{base}sub/{subId}` (same origin as the panel URL).
 * If an install uses a non-default sub path or host, this may need a panel-derived URL later.
 */
export function buildSubscriptionUrl(panelBaseUrl: string, subId: string): string {
  const base = normalizePanelBaseUrl(panelBaseUrl);
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

type PanelJson = { success?: boolean; msg?: string; obj?: unknown };

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

function resolveVlessShareLink(input: {
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
  const base = normalizePanelBaseUrl(input.panelBaseUrl);
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

  const loginJson = await readPanelJson(loginResponse);
  requireSuccess(loginJson, "login failed");

  const cookieHeader = extractSessionCookieHeader(readSetCookieLines(loginResponse.headers));
  if (!cookieHeader) {
    throw new PanelRequestError("login succeeded but session cookie (3x-ui) was not set");
  }

  const addUrl = new URL("panel/api/inbounds/add", base).href;
  const addResponse = await fetchFn(addUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: cookieHeader,
    },
    body: JSON.stringify(input.inboundBody),
  });

  const addJson = await readPanelJson(addResponse);
  requireSuccess(addJson, "add inbound failed");

  const subId = parseSubIdFromInboundBody(input.inboundBody);
  const subscriptionUrl = buildSubscriptionUrl(base, subId);
  const vlessShareLink = resolveVlessShareLink({
    panelBaseUrl: base,
    inboundBody: input.inboundBody,
    addJson,
  });

  return { vlessShareLink, subscriptionUrl };
}
