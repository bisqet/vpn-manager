import {
  type PanelJson,
  PanelRequestError,
  withPanelTlsInsecureHttpFallback,
} from "./provisionChainClientAccess";

export function readSetCookieLines(headers: Headers): string[] {
  const extended = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") return extended.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function extractSessionCookieHeader(setCookieLines: string[]): string {
  for (const line of setCookieLines) {
    const match = /^3x-ui=([^;]+)/.exec(line.trim());
    if (match) return `3x-ui=${match[1]}`;
  }
  return "";
}

export async function readPanelJson(response: Response): Promise<PanelJson> {
  if (!response.ok) {
    throw new PanelRequestError(`panel HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PanelRequestError("panel returned non-JSON body");
  }
  if (body === null || typeof body !== "object") {
    throw new PanelRequestError("panel returned non-object JSON");
  }
  return body as PanelJson;
}

export function requireSuccess(json: PanelJson, fallbackMessage: string): void {
  if (json.success !== true) {
    throw new PanelRequestError(typeof json.msg === "string" && json.msg !== "" ? json.msg : fallbackMessage);
  }
}

export async function loginCookie(input: {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  fetchFn: typeof fetch;
}): Promise<{ base: string; cookieHeader: string }> {
  return withPanelTlsInsecureHttpFallback(input.panelBaseUrl, async (base) => {
    const loginUrl = new URL("login", base).href;
    const loginBody = new URLSearchParams({
      username: input.adminUsername,
      password: input.adminPassword,
      twoFactorCode: "",
    });

    const loginResponse = await input.fetchFn(loginUrl, {
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
    return { base, cookieHeader };
  });
}
