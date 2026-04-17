import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fetchPanelXrayBundle, restartPanelXrayService, updatePanelXraySetting } from "./panelXrayClient";

describe("panelXrayClient", () => {
  beforeEach(() => {
    delete process.env.VPN_MANAGER_PANEL_TLS_INSECURE;
  });

  test("fetchPanelXrayBundle POSTs panel/xray/, parses obj string, returns stringified xraySetting and outboundTestUrl", async () => {
    const xraySetting = { log: { loglevel: "warning" }, inbounds: [], outbounds: [] };
    const objPayload = {
      xraySetting,
      inboundTags: ["tag-in"],
      outboundTestUrl: "https://example.com/gen204",
    };

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url.endsWith("/panel/xray/")).toBe(true);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("3x-ui=sess");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")?.toLowerCase()).toContain("application/x-www-form-urlencoded");
      expect(init?.body).toBe("");

      return new Response(
        JSON.stringify({
          success: true,
          msg: "ok",
          obj: JSON.stringify(objPayload),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const out = await fetchPanelXrayBundle({
      panelBaseUrl: "https://panel.example/",
      cookieHeader: "3x-ui=sess",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(out.xraySettingText).toBe(JSON.stringify(xraySetting));
    expect(out.outboundTestUrl).toBe("https://example.com/gen204");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("updatePanelXraySetting POSTs form body with xraySetting and outboundTestUrl", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url.endsWith("/panel/xray/update")).toBe(true);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("3x-ui=z");
      expect(headers.get("content-type")?.toLowerCase()).toContain("application/x-www-form-urlencoded");
      const params = new URLSearchParams(init?.body as string);
      expect(params.get("xraySetting")).toBe('{"a":1}');
      expect(params.get("outboundTestUrl")).toBe("https://www.google.com/generate_204");

      return new Response(JSON.stringify({ success: true, msg: "saved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await updatePanelXraySetting({
      panelBaseUrl: "https://p/",
      cookieHeader: "3x-ui=z",
      xraySettingText: '{"a":1}',
      outboundTestUrl: "https://www.google.com/generate_204",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("restartPanelXrayService POSTs panel/api/server/restartXrayService", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url.endsWith("/panel/api/server/restartXrayService")).toBe(true);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("3x-ui=r");
      return new Response(JSON.stringify({ success: true, msg: "restarted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await restartPanelXrayService({
      panelBaseUrl: "https://panel.test/base/",
      cookieHeader: "3x-ui=r",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("when VPN_MANAGER_PANEL_TLS_INSECURE is set, retries with http after https fetch throws", async () => {
    process.env.VPN_MANAGER_PANEL_TLS_INSECURE = "true";

    const xraySetting = { log: {}, inbounds: [], outbounds: [] };
    const objPayload = {
      xraySetting,
      inboundTags: [],
      outboundTestUrl: "https://www.google.com/generate_204",
    };

    const seenUrls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      if (url.startsWith("https://") && url.endsWith("/panel/xray/")) {
        throw new Error("TLS handshake failed");
      }
      if (url === "http://panel.fallback/web/panel/xray/") {
        return new Response(
          JSON.stringify({
            success: true,
            msg: "ok",
            obj: JSON.stringify(objPayload),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const out = await fetchPanelXrayBundle({
      panelBaseUrl: "https://panel.fallback/web/",
      cookieHeader: "3x-ui=sess",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(seenUrls[0]).toBe("https://panel.fallback/web/panel/xray/");
    expect(seenUrls[1]).toBe("http://panel.fallback/web/panel/xray/");
    expect(out.xraySettingText).toBe(JSON.stringify(xraySetting));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
