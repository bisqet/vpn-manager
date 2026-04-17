import { describe, expect, mock, test } from "bun:test";
import { deletePanelInboundById, resolveInboundIdByTag } from "./panelInboundDelete";

describe("deletePanelInboundById", () => {
  test("POSTs /panel/api/inbounds/del/{id}", async () => {
    const seen: string[] = [];
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url.endsWith("/panel/api/inbounds/del/42")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await deletePanelInboundById({
      panelApiBase: "http://panel.example/prefix/",
      cookieHeader: "3x-ui=abc",
      inboundId: 42,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(seen.some((u) => u.includes("/panel/api/inbounds/del/42"))).toBe(true);
  });
});

describe("resolveInboundIdByTag", () => {
  test("returns id from list obj when tag matches", async () => {
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/panel/api/inbounds/list")) {
        return new Response(
          JSON.stringify({ success: true, msg: "ok", obj: [{ id: 7, tag: "inbound-443" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const id = await resolveInboundIdByTag({
      panelApiBase: "http://panel.example/prefix/",
      cookieHeader: "3x-ui=abc",
      inboundTag: "inbound-443",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(id).toBe(7);
  });
});
