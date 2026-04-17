import { describe, expect, mock, test } from "bun:test";
import { compensateCreatedInbounds } from "./compensateChainProvision";
import type { CreatedInboundRef } from "./provisionMultihopChainClientAccess";

function jsonResponse(body: unknown, init?: ResponseInit & { setCookie?: string }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init?.setCookie) headers.append("set-cookie", init.setCookie);
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers,
  });
}

describe("compensateCreatedInbounds", () => {
  test("deletes inbounds in reverse creation order (del/3 before del/2 before del/1)", async () => {
    const urls: string[] = [];
    const refs: CreatedInboundRef[] = [
      {
        panelBaseUrl: "https://hop-a.example.com/",
        adminUsername: "u1",
        adminPassword: "p1",
        inboundTag: "tag-inbound-1",
        inboundId: 1,
      },
      {
        panelBaseUrl: "https://hop-b.example.com/",
        adminUsername: "u2",
        adminPassword: "p2",
        inboundTag: "tag-inbound-2",
        inboundId: 2,
      },
      {
        panelBaseUrl: "https://hop-c.example.com/",
        adminUsername: "u3",
        adminPassword: "p3",
        inboundTag: "tag-inbound-3",
        inboundId: 3,
      },
    ];

    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);

      if (url.endsWith("/login")) {
        return jsonResponse({ success: true, msg: "" }, { setCookie: "3x-ui=sessiontoken; Path=/" });
      }
      if (url.includes("/panel/api/inbounds/list")) {
        return jsonResponse({ success: true, msg: "ok", obj: [] });
      }
      if (/\/panel\/api\/inbounds\/del\/[123]$/.exec(url)) {
        return jsonResponse({ success: true, msg: "ok" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await compensateCreatedInbounds({
      createdInbounds: refs,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const delUrls = urls.filter((u) => u.includes("/panel/api/inbounds/del/"));
    expect(delUrls.length).toBe(3);
    expect(delUrls[0]).toContain("/panel/api/inbounds/del/3");
    expect(delUrls[1]).toContain("/panel/api/inbounds/del/2");
    expect(delUrls[2]).toContain("/panel/api/inbounds/del/1");

    const i3 = urls.findIndex((u) => u.includes("/panel/api/inbounds/del/3"));
    const i2 = urls.findIndex((u) => u.includes("/panel/api/inbounds/del/2"));
    const i1 = urls.findIndex((u) => u.includes("/panel/api/inbounds/del/1"));
    expect(i3 < i2 && i2 < i1).toBe(true);
  });
});
