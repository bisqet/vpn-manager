import { PanelRequestError, withPanelTlsInsecureHttpFallback } from "./provisionChainClientAccess";

export type PanelXrayBundle = { xraySettingText: string; outboundTestUrl: string };

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

const DEFAULT_OUTBOUND_TEST_URL = "https://www.google.com/generate_204";

type XrayPanelObj = {
  xraySetting?: unknown;
  inboundTags?: unknown;
  outboundTestUrl?: unknown;
};

function parseXrayPanelObjString(objStr: string): XrayPanelObj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(objStr);
  } catch {
    throw new PanelRequestError("panel xray obj must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PanelRequestError("panel xray obj must be a JSON object");
  }
  return parsed as XrayPanelObj;
}

export async function fetchPanelXrayBundle(input: {
  panelBaseUrl: string;
  cookieHeader: string;
  fetchFn?: typeof fetch;
}): Promise<PanelXrayBundle> {
  return withPanelTlsInsecureHttpFallback(input.panelBaseUrl, async (base) => {
    const fetchFn = input.fetchFn ?? fetch;
    const url = `${base}panel/xray/`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        cookie: input.cookieHeader,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams().toString(),
    });
    const json = await readPanelJson(response);
    requireSuccess(json, "fetch panel xray failed");
    if (typeof json.obj !== "string") {
      throw new PanelRequestError("panel xray response obj must be a string");
    }
    const inner = parseXrayPanelObjString(json.obj);
    if (!("xraySetting" in inner)) {
      throw new PanelRequestError("panel xray obj missing xraySetting");
    }
    const outboundTestUrl =
      typeof inner.outboundTestUrl === "string" && inner.outboundTestUrl !== ""
        ? inner.outboundTestUrl
        : DEFAULT_OUTBOUND_TEST_URL;
    return {
      xraySettingText: JSON.stringify(inner.xraySetting),
      outboundTestUrl,
    };
  });
}

export async function updatePanelXraySetting(input: {
  panelBaseUrl: string;
  cookieHeader: string;
  xraySettingText: string;
  outboundTestUrl: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  return withPanelTlsInsecureHttpFallback(input.panelBaseUrl, async (base) => {
    const fetchFn = input.fetchFn ?? fetch;
    const url = `${base}panel/xray/update`;
    const body = new URLSearchParams({
      xraySetting: input.xraySettingText,
      outboundTestUrl: input.outboundTestUrl,
    });
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        cookie: input.cookieHeader,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: body.toString(),
    });
    const json = await readPanelJson(response);
    requireSuccess(json, "update panel xray failed");
  });
}

export async function restartPanelXrayService(input: {
  panelBaseUrl: string;
  cookieHeader: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  return withPanelTlsInsecureHttpFallback(input.panelBaseUrl, async (base) => {
    const fetchFn = input.fetchFn ?? fetch;
    const url = `${base}panel/api/server/restartXrayService`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        cookie: input.cookieHeader,
        accept: "application/json",
      },
    });
    const json = await readPanelJson(response);
    requireSuccess(json, "restart xray service failed");
  });
}
