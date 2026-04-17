import { describe, expect, test } from "bun:test";
import {
  buildPanelHttpsUrl,
  buildPanelLoopbackHttpUrl,
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

describe("httpsUrlHost", () => {
  test("brackets public IPv6", () => {
    const pub = "2001:4860:4860::8888";
    expect(httpsUrlHost(pub)).toBe("[2001:4860:4860::8888]");
  });
});

describe("buildPanelLoopbackHttpUrl", () => {
  test("returns null for bad port or path", () => {
    expect(buildPanelLoopbackHttpUrl(2053, null)).toBeNull();
    expect(buildPanelLoopbackHttpUrl(2053, "")).toBeNull();
    expect(buildPanelLoopbackHttpUrl(0, "a")).toBeNull();
  });
  test("normalizes path", () => {
    expect(buildPanelLoopbackHttpUrl(2053, "abc")).toBe("http://127.0.0.1:2053/abc/");
    expect(buildPanelLoopbackHttpUrl(2053, "/abc")).toBe("http://127.0.0.1:2053/abc/");
  });
});

describe("buildPanelHttpsUrl", () => {
  test("returns null when webBasePath missing", () => {
    expect(buildPanelHttpsUrl("panel.example.com", null)).toBeNull();
    expect(buildPanelHttpsUrl("panel.example.com", "")).toBeNull();
  });
  test("returns null when panel hostname empty", () => {
    expect(buildPanelHttpsUrl("", "abc")).toBeNull();
  });
  test("FQDN with path without leading slash", () => {
    expect(buildPanelHttpsUrl("panel.example.com", "myPath")).toBe("https://panel.example.com/myPath/");
  });
  test("FQDN with path with leading slash", () => {
    expect(buildPanelHttpsUrl("panel.example.com", "/myPath")).toBe("https://panel.example.com/myPath/");
  });
  test("public IPv4 panel", () => {
    expect(buildPanelHttpsUrl("203.0.113.5", "xyz")).toBe("https://203.0.113.5/xyz/");
  });
  test("public IPv6 panel brackets host", () => {
    expect(buildPanelHttpsUrl("2001:4860:4860::8888", "p")).toBe("https://[2001:4860:4860::8888]/p/");
  });
  test("includes explicit non-443 port for direct x-ui listener", () => {
    expect(buildPanelHttpsUrl("203.0.113.55", "xUiDocBase18char", 45543)).toBe(
      "https://203.0.113.55:45543/xUiDocBase18char/",
    );
  });
  test("omits port for null or 443", () => {
    expect(buildPanelHttpsUrl("panel.example.com", "p", null)).toBe("https://panel.example.com/p/");
    expect(buildPanelHttpsUrl("panel.example.com", "p", 443)).toBe("https://panel.example.com/p/");
  });
  test("IPv6 with explicit port", () => {
    expect(buildPanelHttpsUrl("2001:4860:4860::8888", "p", 8443)).toBe(
      "https://[2001:4860:4860::8888]:8443/p/",
    );
  });
});
