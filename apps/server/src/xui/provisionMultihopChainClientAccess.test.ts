import { beforeEach, describe, expect, mock, test } from "bun:test";
import { buildVlessRealityInboundBody } from "./buildVlessRealityInboundBody";
import { provisionMultihopChainClientAccess } from "./provisionMultihopChainClientAccess";

describe("provisionMultihopChainClientAccess", () => {
  beforeEach(() => {
    delete process.env.VPN_MANAGER_PANEL_TLS_INSECURE;
  });

  test("two hops: provisions downstream inbound, user inbound, xray updates on both panels, returns hop0 links", async () => {
    const hop0Base = "https://entry.example.com/web/";
    const hop1Base = "https://relay.example.com/web/";

    const inboundForAddResponse = (tag: string, port: number, settings: string, streamSettings: string) => ({
      success: true,
      msg: "ok",
      obj: { id: 9000 + port, tag, port, protocol: "vless", settings, streamSettings },
    });

    const xrayBundleObj = {
      xraySetting: {
        log: {},
        inbounds: [],
        outbounds: [
          { tag: "direct", protocol: "freedom", settings: {} },
          { tag: "blocked", protocol: "blackhole", settings: {} },
        ],
        routing: { domainStrategy: "AsIs", rules: [] },
      },
      inboundTags: [],
      outboundTestUrl: "https://www.google.com/generate_204",
    };

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "3x-ui=session; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/panel/api/inbounds/list")) {
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("relay.example.com") && url.endsWith("/panel/api/inbounds/add")) {
        const body = JSON.parse(init?.body as string) as Record<string, string | number>;
        const p = Number(body.port);
        return new Response(
          JSON.stringify(
            inboundForAddResponse(`inbound-${p}`, p, body.settings as string, body.streamSettings as string),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("entry.example.com") && url.endsWith("/panel/api/inbounds/add")) {
        const body = JSON.parse(init?.body as string) as Record<string, string | number>;
        const p = Number(body.port);
        return new Response(
          JSON.stringify(
            inboundForAddResponse(`inbound-${p}`, p, body.settings as string, body.streamSettings as string),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/panel/xray/")) {
        return new Response(
          JSON.stringify({
            success: true,
            msg: "ok",
            obj: JSON.stringify(xrayBundleObj),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/panel/xray/update")) {
        return new Response(JSON.stringify({ success: true, msg: "saved" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/panel/api/server/restartXrayService")) {
        return new Response(JSON.stringify({ success: true, msg: "restarted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    const out = await provisionMultihopChainClientAccess({
      chainId: 9,
      hops: [
        {
          panelBaseUrl: hop0Base,
          adminUsername: "admin",
          adminPassword: "a",
          dialHost: "ignored-for-entry",
        },
        {
          panelBaseUrl: hop1Base,
          adminUsername: "admin",
          adminPassword: "b",
          dialHost: "relay.example.com",
        },
      ],
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(out.vlessShareLink.startsWith("vless://")).toBe(true);
    expect(out.subscriptionUrl).toContain("/sub/");
    expect(out.createdInbounds).toHaveLength(2);
    expect(out.createdInbounds[0]!.panelBaseUrl).toBe(hop1Base);
    expect(out.createdInbounds[0]!.inboundTag.startsWith("inbound-")).toBe(true);
    expect(out.createdInbounds[0]!.inboundId).toBe(9000 + Number(out.createdInbounds[0]!.inboundTag.replace(/^inbound-/, "")));
    expect(out.createdInbounds[1]!.panelBaseUrl).toBe(hop0Base);
    expect(out.createdInbounds[1]!.inboundTag.startsWith("inbound-")).toBe(true);
    expect(out.createdInbounds[1]!.inboundId).toBe(9000 + Number(out.createdInbounds[1]!.inboundTag.replace(/^inbound-/, "")));
    // hop1 login+list+add, hop0 login+list+add, hop0 login+xray+update+restart, hop1 login+xray+update+restart
    expect(fetchMock.mock.calls.length).toBe(14);
  });

  test("single hop delegates to provisionChainClientAccess (login, list, add)", async () => {
    const inboundBody = buildVlessRealityInboundBody({
      port: 4433,
      remark: "solo",
      clientEmail: "c@example.com",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "a1b2c3d4e5f6789a",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 3).toString("base64url"),
      realityPublicKeyB64: Buffer.alloc(32, 5).toString("base64url"),
    });
    const settingsClients = JSON.parse(inboundBody.settings) as { clients: unknown[] };

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          headers: { "set-cookie": "3x-ui=abc; Path=/", "content-type": "application/json" },
        });
      }
      if (url.endsWith("/panel/api/inbounds/list")) {
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/panel/api/inbounds/add")) {
        const sent = JSON.parse(init?.body as string) as { port: number; settings: string; streamSettings: string };
        const addObj = {
          id: 99,
          port: sent.port,
          protocol: "vless",
          settings: JSON.stringify(settingsClients),
          streamSettings: sent.streamSettings,
        };
        return new Response(JSON.stringify({ success: true, msg: "ok", obj: addObj }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(url);
    });

    const out = await provisionMultihopChainClientAccess({
      chainId: 1,
      hops: [
        {
          panelBaseUrl: "https://panel.test/",
          adminUsername: "admin",
          adminPassword: "secret",
          dialHost: "panel.test",
        },
      ],
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(out.vlessShareLink.startsWith("vless://")).toBe(true);
    expect(out.createdInbounds).toHaveLength(1);
    expect(out.createdInbounds[0]).toMatchObject({
      panelBaseUrl: "https://panel.test/",
      adminUsername: "admin",
      adminPassword: "secret",
      inboundId: 99,
    });
    expect(out.createdInbounds[0]!.inboundTag).toMatch(/^inbound-\d+$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
