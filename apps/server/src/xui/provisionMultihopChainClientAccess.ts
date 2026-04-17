import { buildVlessRealityInboundBody } from "./buildVlessRealityInboundBody";
import { buildVlessRealityOutbound } from "./buildVlessRealityOutbound";
import {
  appendOutbound,
  findFreedomOutboundTag,
  mergeInboundToOutboundRule,
} from "./mergeChainRoutingIntoXray";
import {
  fetchPanelXrayBundle,
  restartPanelXrayService,
  updatePanelXraySetting,
} from "./panelXrayClient";
import {
  type ChainClientAccessResult,
  type PanelJson,
  PanelRequestError,
  buildSubscriptionUrl,
  fetchInboundUsedPorts,
  pickFreeListenPort,
  provisionChainClientAccess,
  resolveVlessShareLink,
} from "./provisionChainClientAccess";
import { loginCookie, readPanelJson, requireSuccess } from "./panelLoginCookie";
import { generateRealityClientMaterial } from "./realityKeyMaterial";

export type HopPanelContext = {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  dialHost: string;
};

export type ProvisionMultihopChainClientAccessInput = {
  chainId: number;
  hops: HopPanelContext[];
  fetchFn?: typeof fetch;
};

type CreatedInboundEdge = {
  port: number;
  inboundTag: string;
  clientUuid: string;
  realityPublicKeyB64: string;
  shortId: string;
};

function inboundTagFromAddResponse(addJson: PanelJson, inboundBody: Record<string, unknown>): string {
  const obj = addJson.obj;
  if (obj && typeof obj === "object") {
    const tag = (obj as Record<string, unknown>).tag;
    if (typeof tag === "string" && tag.trim() !== "") return tag;
  }
  const portRaw = inboundBody.port;
  const port =
    typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number(portRaw) : NaN;
  if (Number.isFinite(port) && port > 0) {
    return `inbound-${port}`;
  }
  throw new PanelRequestError("unable to determine inbound tag from panel response");
}

async function addInbound(input: {
  base: string;
  cookieHeader: string;
  inboundBody: Record<string, unknown>;
  fetchFn: typeof fetch;
}): Promise<PanelJson> {
  const addUrl = new URL("panel/api/inbounds/add", input.base).href;
  const addResponse = await input.fetchFn(addUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: input.cookieHeader,
    },
    body: JSON.stringify(input.inboundBody),
  });
  const addJson = await readPanelJson(addResponse);
  requireSuccess(addJson, "add inbound failed");
  return addJson;
}

function parseSubIdFromInboundBody(inboundBody: Record<string, unknown>): string {
  const settings = inboundBody.settings;
  if (typeof settings !== "string") {
    throw new PanelRequestError("inboundBody.settings must be a JSON string");
  }
  const parsed: unknown = JSON.parse(settings);
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

export async function provisionMultihopChainClientAccess(
  input: ProvisionMultihopChainClientAccessInput,
): Promise<ChainClientAccessResult> {
  const hops = input.hops;
  const fetchFn = input.fetchFn ?? fetch;
  if (hops.length === 0) {
    throw new PanelRequestError("chain has no hops");
  }
  if (hops.length === 1) {
    const h = hops[0]!;
    const material = await generateRealityClientMaterial();
    const inboundBody = buildVlessRealityInboundBody({
      port: 443,
      remark: `chain-${input.chainId}-${Date.now()}`,
      clientEmail: `vpnmgr-${material.clientUuid}@chain-${input.chainId}.local`,
      clientUuid: material.clientUuid,
      subId: material.subId,
      shortId: material.shortId,
      realityPrivateKeyB64: material.realityPrivateKeyB64,
      realityPublicKeyB64: material.realityPublicKeyB64,
    });
    return provisionChainClientAccess({
      panelBaseUrl: h.panelBaseUrl,
      adminUsername: h.adminUsername,
      adminPassword: h.adminPassword,
      inboundBody: inboundBody as unknown as Record<string, unknown>,
      fetchFn,
    });
  }

  const runId = `${Date.now()}`;
  const edgeByDownstreamIndex = new Map<number, CreatedInboundEdge>();
  const receivedInboundTagByHopIndex = new Map<number, string>();

  for (let k = hops.length - 1; k >= 1; k--) {
    const hop = hops[k]!;
    const material = await generateRealityClientMaterial();

    const { base, cookieHeader } = await loginCookie({
      panelBaseUrl: hop.panelBaseUrl,
      adminUsername: hop.adminUsername,
      adminPassword: hop.adminPassword,
      fetchFn,
    });
    const usedOnHop = await fetchInboundUsedPorts({ panelApiBase: base, cookieHeader, fetchFn });
    const listenPort = pickFreeListenPort(usedOnHop);
    const inboundBody = buildVlessRealityInboundBody({
      port: listenPort,
      remark: `chain-${input.chainId}-${runId}-recv-${k}`,
      clientEmail: `vpnmgr-${material.clientUuid}@chain-${input.chainId}-hop${k}.local`,
      clientUuid: material.clientUuid,
      subId: material.subId,
      shortId: material.shortId,
      realityPrivateKeyB64: material.realityPrivateKeyB64,
      realityPublicKeyB64: material.realityPublicKeyB64,
    }) as unknown as Record<string, unknown>;

    const addJson = await addInbound({ base, cookieHeader, inboundBody, fetchFn });
    const inboundTag = inboundTagFromAddResponse(addJson, inboundBody);
    const portRaw = inboundBody.port;
    const port =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number(portRaw) : NaN;
    if (!Number.isFinite(port) || port <= 0) {
      throw new PanelRequestError("inbound port invalid");
    }
    receivedInboundTagByHopIndex.set(k, inboundTag);
    edgeByDownstreamIndex.set(k, {
      port,
      inboundTag,
      clientUuid: material.clientUuid,
      realityPublicKeyB64: material.realityPublicKeyB64,
      shortId: material.shortId,
    });
  }

  const entry = hops[0]!;
  const entryMaterial = await generateRealityClientMaterial();

  const entrySession = await loginCookie({
    panelBaseUrl: entry.panelBaseUrl,
    adminUsername: entry.adminUsername,
    adminPassword: entry.adminPassword,
    fetchFn,
  });
  const usedOnEntry = await fetchInboundUsedPorts({
    panelApiBase: entrySession.base,
    cookieHeader: entrySession.cookieHeader,
    fetchFn,
  });
  const entryListenPort = pickFreeListenPort(usedOnEntry);
  const userInboundBody = buildVlessRealityInboundBody({
    port: entryListenPort,
    remark: `chain-${input.chainId}-${runId}-user`,
    clientEmail: `vpnmgr-${entryMaterial.clientUuid}@chain-${input.chainId}.local`,
    clientUuid: entryMaterial.clientUuid,
    subId: entryMaterial.subId,
    shortId: entryMaterial.shortId,
    realityPrivateKeyB64: entryMaterial.realityPrivateKeyB64,
    realityPublicKeyB64: entryMaterial.realityPublicKeyB64,
  }) as unknown as Record<string, unknown>;

  const userAddJson = await addInbound({
    base: entrySession.base,
    cookieHeader: entrySession.cookieHeader,
    inboundBody: userInboundBody,
    fetchFn,
  });
  const userInboundTag = inboundTagFromAddResponse(userAddJson, userInboundBody);
  receivedInboundTagByHopIndex.set(0, userInboundTag);

  const subId = parseSubIdFromInboundBody(userInboundBody);
  const subscriptionUrl = buildSubscriptionUrl(entrySession.base, subId);
  const vlessShareLink = resolveVlessShareLink({
    panelBaseUrl: entrySession.base,
    inboundBody: userInboundBody,
    addJson: userAddJson,
  });

  for (let k = 0; k <= hops.length - 2; k++) {
    const hop = hops[k]!;
    const nextHop = hops[k + 1]!;
    const edge = edgeByDownstreamIndex.get(k + 1);
    if (!edge) {
      throw new PanelRequestError("internal: missing edge for downstream hop");
    }
    const inboundTag = k === 0 ? userInboundTag : receivedInboundTagByHopIndex.get(k);
    if (!inboundTag) {
      throw new PanelRequestError("internal: missing inbound tag for forwarding hop");
    }

    const outboundTag = `vpnmgr-chain-${input.chainId}-${runId}-out-${k}`;
    const outbound = buildVlessRealityOutbound({
      tag: outboundTag,
      address: nextHop.dialHost,
      port: edge.port,
      uuid: edge.clientUuid,
      publicKey: edge.realityPublicKeyB64,
      shortId: edge.shortId,
    });

    const { base, cookieHeader } = await loginCookie({
      panelBaseUrl: hop.panelBaseUrl,
      adminUsername: hop.adminUsername,
      adminPassword: hop.adminPassword,
      fetchFn,
    });
    const bundle = await fetchPanelXrayBundle({ panelBaseUrl: hop.panelBaseUrl, cookieHeader, fetchFn });
    const xrayObj = JSON.parse(bundle.xraySettingText) as Record<string, unknown>;
    let merged = appendOutbound({ xray: xrayObj, outbound });
    merged = mergeInboundToOutboundRule({
      xray: merged,
      inboundTag,
      outboundTag,
    });
    await updatePanelXraySetting({
      panelBaseUrl: hop.panelBaseUrl,
      cookieHeader,
      xraySettingText: JSON.stringify(merged),
      outboundTestUrl: bundle.outboundTestUrl,
      fetchFn,
    });
    await restartPanelXrayService({ panelBaseUrl: hop.panelBaseUrl, cookieHeader, fetchFn });
  }

  const lastIndex = hops.length - 1;
  const lastHop = hops[lastIndex]!;
  const lastInboundTag = receivedInboundTagByHopIndex.get(lastIndex);
  if (!lastInboundTag) {
    throw new PanelRequestError("internal: missing last hop inbound tag");
  }
  const lastSession = await loginCookie({
    panelBaseUrl: lastHop.panelBaseUrl,
    adminUsername: lastHop.adminUsername,
    adminPassword: lastHop.adminPassword,
    fetchFn,
  });
  const lastBundle = await fetchPanelXrayBundle({
    panelBaseUrl: lastHop.panelBaseUrl,
    cookieHeader: lastSession.cookieHeader,
    fetchFn,
  });
  const lastXray = JSON.parse(lastBundle.xraySettingText) as Record<string, unknown>;
  const directTag = findFreedomOutboundTag(lastXray as { outbounds?: unknown[] });
  const lastMerged = mergeInboundToOutboundRule({
    xray: lastXray,
    inboundTag: lastInboundTag,
    outboundTag: directTag,
  });
  await updatePanelXraySetting({
    panelBaseUrl: lastHop.panelBaseUrl,
    cookieHeader: lastSession.cookieHeader,
    xraySettingText: JSON.stringify(lastMerged),
    outboundTestUrl: lastBundle.outboundTestUrl,
    fetchFn,
  });
  await restartPanelXrayService({
    panelBaseUrl: lastHop.panelBaseUrl,
    cookieHeader: lastSession.cookieHeader,
    fetchFn,
  });

  return { vlessShareLink, subscriptionUrl };
}
