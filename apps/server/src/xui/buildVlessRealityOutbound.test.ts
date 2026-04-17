import { describe, expect, test } from "bun:test";
import { buildVlessRealityOutbound } from "./buildVlessRealityOutbound";

describe("buildVlessRealityOutbound", () => {
  test("builds vless outbound with vision flow and reality to yahoo.com", () => {
    const publicKey = Buffer.alloc(32, 5).toString("base64url");
    const o = buildVlessRealityOutbound({
      tag: "vpnmgr-out-test",
      address: "hop2.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      publicKey,
      shortId: "0123456789abcdef",
    });
    expect(o.tag).toBe("vpnmgr-out-test");
    expect(o.protocol).toBe("vless");
    const vnext = (
      o.settings as {
        vnext: { address: string; port: number; users: { id: string; flow: string }[] }[];
      }
    ).vnext;
    expect(vnext[0]!.address).toBe("hop2.example.com");
    expect(vnext[0]!.port).toBe(443);
    expect(vnext[0]!.users[0]!.flow).toBe("xtls-rprx-vision");
    const stream = o.streamSettings as {
      security: string;
      realitySettings: {
        serverName: string;
        publicKey: string;
        shortId: string;
        fingerprint: string;
        spiderX: string;
      };
    };
    expect(stream.security).toBe("reality");
    expect(stream.realitySettings.serverName).toBe("yahoo.com");
    expect(stream.realitySettings.publicKey).toBe(publicKey);
    expect(stream.realitySettings.shortId).toBe("0123456789abcdef");
  });
});
