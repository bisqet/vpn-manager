import { beforeEach, describe, expect, mock, test } from "bun:test";
import { buildVlessRealityInboundBody } from "./buildVlessRealityInboundBody";
import {
  PanelRequestError,
  buildSubscriptionUrl,
  pickFreeListenPort,
  provisionChainClientAccess,
} from "./provisionChainClientAccess";

describe("buildSubscriptionUrl", () => {
  test("resolves 3x-ui style /sub/{subId} relative to normalized panel base", () => {
    expect(buildSubscriptionUrl("https://panel.example.com:8443", "a1b2c3d4e5f6789a")).toBe(
      "https://panel.example.com:8443/sub/a1b2c3d4e5f6789a",
    );
    expect(buildSubscriptionUrl("https://panel.example.com/prefix/", "x")).toBe(
      "https://panel.example.com/prefix/sub/x",
    );
  });
});

describe("pickFreeListenPort", () => {
  test("prefers 443 when unused", () => {
    expect(pickFreeListenPort(new Set())).toBe(443);
  });

  test("uses 8443 when 443 is taken", () => {
    expect(pickFreeListenPort(new Set([443]))).toBe(8443);
  });
});

describe("provisionChainClientAccess", () => {
  beforeEach(() => {
    delete process.env.VPN_MANAGER_PANEL_TLS_INSECURE;
  });

  test("logs in with form POST, adds inbound with session cookie, returns subscription URL and vless link", async () => {
    const inboundBody = buildVlessRealityInboundBody({
      port: 4433,
      remark: "chain",
      clientEmail: "c@example.com",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "a1b2c3d4e5f6789a",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 3).toString("base64"),
      realityPublicKeyB64: Buffer.alloc(32, 5).toString("base64"),
    });

    const settingsClients = JSON.parse(inboundBody.settings) as { clients: unknown[] };

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith("/login")) {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toBeDefined();
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")?.toLowerCase()).toContain("application/x-www-form-urlencoded");
        expect(typeof init?.body).toBe("string");
        const params = new URLSearchParams(init?.body as string);
        expect(params.get("username")).toBe("admin");
        expect(params.get("password")).toBe("secret");
        expect(params.get("twoFactorCode")).toBe("");

        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "3x-ui=abc; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/panel/api/inbounds/list")) {
        expect(init?.method ?? "GET").toBe("GET");
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/panel/api/inbounds/add")) {
        expect(init?.method ?? "POST").toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toContain("3x-ui=abc");
        expect(headers.get("content-type")?.toLowerCase()).toContain("application/json");
        const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(sent.port).toBe(443);

        const addObj = {
          port: 443,
          protocol: "vless",
          settings: JSON.stringify(settingsClients),
          streamSettings: inboundBody.streamSettings,
        };
        expect(init?.body).toBe(JSON.stringify({ ...inboundBody, port: 443 }));

        return new Response(
          JSON.stringify({
            success: true,
            msg: "created",
            obj: addObj,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch url: ${url}`);
    });

    const out = await provisionChainClientAccess({
      panelBaseUrl: "https://panel.test/",
      adminUsername: "admin",
      adminPassword: "secret",
      inboundBody,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.subscriptionUrl).toContain("a1b2c3d4e5f6789a");
    expect(out.subscriptionUrl).toContain("/sub/");
    expect(out.vlessShareLink.startsWith("vless://")).toBe(true);
  });

  test("throws PanelRequestError when inbound add reports success false", async () => {
    const inboundBody = buildVlessRealityInboundBody({
      port: 1,
      remark: "x",
      clientEmail: "c@example.com",
      clientUuid: "22222222-2222-4222-8222-222222222222",
      subId: "subidfail",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 1).toString("base64"),
      realityPublicKeyB64: Buffer.alloc(32, 2).toString("base64"),
    });

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          headers: { "set-cookie": "3x-ui=abc; Path=/" },
        });
      }
      if (url.endsWith("/panel/api/inbounds/list")) {
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: false, msg: "duplicate port" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await provisionChainClientAccess({
        panelBaseUrl: "https://p/",
        adminUsername: "a",
        adminPassword: "b",
        inboundBody,
        fetchFn: fetchMock as unknown as typeof fetch,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PanelRequestError);
      expect((err as PanelRequestError).panelMessage).toBe("duplicate port");
    }
  });

  test("when VPN_MANAGER_PANEL_TLS_INSECURE is set, retries with http:// after https transport failure", async () => {
    process.env.VPN_MANAGER_PANEL_TLS_INSECURE = "true";

    const inboundBody = buildVlessRealityInboundBody({
      port: 4433,
      remark: "chain",
      clientEmail: "c@example.com",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "a1b2c3d4e5f6789a",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 3).toString("base64"),
      realityPublicKeyB64: Buffer.alloc(32, 5).toString("base64"),
    });

    const settingsClients = JSON.parse(inboundBody.settings) as { clients: unknown[] };

    const seenUrls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);

      if (url === "https://panel.downgrade/prefix/login") {
        throw new Error("simulated TLS failure");
      }

      if (url === "http://panel.downgrade/prefix/login") {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "3x-ui=abc; Path=/; HttpOnly",
          },
        });
      }

      if (url === "http://panel.downgrade/prefix/panel/api/inbounds/list") {
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "http://panel.downgrade/prefix/panel/api/inbounds/add") {
        const addObj = {
          port: 443,
          protocol: "vless",
          settings: JSON.stringify(settingsClients),
          streamSettings: inboundBody.streamSettings,
        };
        return new Response(
          JSON.stringify({
            success: true,
            msg: "created",
            obj: addObj,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch url: ${url}`);
    });

    const out = await provisionChainClientAccess({
      panelBaseUrl: "https://panel.downgrade/prefix/",
      adminUsername: "admin",
      adminPassword: "secret",
      inboundBody,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(seenUrls[0]).toBe("https://panel.downgrade/prefix/login");
    expect(seenUrls[1]).toBe("http://panel.downgrade/prefix/login");
    expect(seenUrls[2]).toBe("http://panel.downgrade/prefix/panel/api/inbounds/list");
    expect(seenUrls[3]).toBe("http://panel.downgrade/prefix/panel/api/inbounds/add");
    expect(out.subscriptionUrl.startsWith("http://")).toBe(true);
    expect(out.vlessShareLink.startsWith("vless://")).toBe(true);
  });

  test("when VPN_MANAGER_PANEL_TLS_INSECURE is set but https succeeds, does not call http://", async () => {
    process.env.VPN_MANAGER_PANEL_TLS_INSECURE = "true";

    const inboundBody = buildVlessRealityInboundBody({
      port: 4433,
      remark: "chain",
      clientEmail: "c@example.com",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "a1b2c3d4e5f6789a",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 3).toString("base64"),
      realityPublicKeyB64: Buffer.alloc(32, 5).toString("base64"),
    });

    const settingsClients = JSON.parse(inboundBody.settings) as { clients: unknown[] };
    const addObj = {
      port: 443,
      protocol: "vless",
      settings: JSON.stringify(settingsClients),
      streamSettings: inboundBody.streamSettings,
    };

    const seenUrls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);

      if (url.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "3x-ui=abc; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/panel/api/inbounds/list")) {
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/panel/api/inbounds/add")) {
        return new Response(
          JSON.stringify({
            success: true,
            msg: "created",
            obj: addObj,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch url: ${url}`);
    });

    const out = await provisionChainClientAccess({
      panelBaseUrl: "https://panel.ok/prefix/",
      adminUsername: "admin",
      adminPassword: "secret",
      inboundBody,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(seenUrls.every((u) => u.startsWith("https://"))).toBe(true);
    expect(out.subscriptionUrl.startsWith("https://")).toBe(true);
  });
});
