import { describe, expect, test } from "bun:test";
import { parseVlessUri } from "./vless-test.ts";

describe("parseVlessRealityUri", () => {
  test("parses standard REALITY vision link", () => {
    const uri =
      "vless://550e8400-e29b-41d4-a716-446655440000@example.com:8443?encryption=none&flow=xtls-rprx-vision&security=reality&pbk=AbCdEfGh&sni=yahoo.com&sid=0123456789abcdef&type=tcp&headerType=none#remark";
    const p = parseVlessUri(uri);
    expect(p.uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(p.address).toBe("example.com");
    expect(p.port).toBe(8443);
    expect(p.flow).toBe("xtls-rprx-vision");
    expect(p.sni).toBe("yahoo.com");
    expect(p.publicKey).toBe("AbCdEfGh");
    expect(p.shortId).toBe("0123456789abcdef");
    expect(p.fingerprint).toBe("chrome");
    expect(p.spiderX).toBe("/");
  });

  test("parses IPv6 host", () => {
    const uri = "vless://u@[::1]:443?security=reality&pbk=p&sni=s&sid=01&type=tcp";
    const p = parseVlessUri(uri);
    expect(p.address).toBe("::1");
    expect(p.port).toBe(443);
  });

  test("rejects non-reality", () => {
    expect(() =>
      parseVlessUri("vless://u@h:443?security=tls&type=tcp&pbk=x&sni=s&sid=1"),
    ).toThrow(/Unsupported security/);
  });
});
