import { describe, expect, test } from "bun:test";
import {
  caddySiteAddressKey,
  httpsUrlHost,
  isPublicIpLiteral,
  resolvePanelHostname,
} from "./panelAddress";

describe("isPublicIpLiteral", () => {
  test("accepts public IPv4", () => {
    expect(isPublicIpLiteral("203.0.113.10")).toBe(true);
  });
  test("rejects RFC1918", () => {
    expect(isPublicIpLiteral("10.0.0.1")).toBe(false);
  });
  test("rejects loopback", () => {
    expect(isPublicIpLiteral("127.0.0.1")).toBe(false);
  });
  test("accepts public IPv6", () => {
    expect(isPublicIpLiteral("2001:4860:4860::8888")).toBe(true);
  });
  test("rejects ULA", () => {
    expect(isPublicIpLiteral("fd12:3456:789a::1")).toBe(false);
  });
});

describe("resolvePanelHostname", () => {
  test("derives from host when panel empty and host public", () => {
    expect(resolvePanelHostname({ host: "203.0.113.1", panel: "" })).toEqual({
      ok: true,
      panel: "203.0.113.1",
    });
  });
  test("requires panel when host not public", () => {
    const r = resolvePanelHostname({ host: "vpn.internal", panel: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("required");
  });
  test("accepts FQDN panel with non-public host", () => {
    expect(resolvePanelHostname({ host: "10.0.0.1", panel: "panel.example.com" })).toEqual({
      ok: true,
      panel: "panel.example.com",
    });
  });
});

describe("caddySiteAddressKey / httpsUrlHost", () => {
  test("brackets public IPv6", () => {
    const pub = "2001:4860:4860::8888";
    expect(caddySiteAddressKey(pub)).toBe("[2001:4860:4860::8888]");
    expect(httpsUrlHost(pub)).toBe("[2001:4860:4860::8888]");
  });
});
