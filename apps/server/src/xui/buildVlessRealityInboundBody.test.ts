import { describe, expect, test } from "bun:test";
import { buildVlessRealityInboundBody } from "./buildVlessRealityInboundBody";

describe("buildVlessRealityInboundBody", () => {
  test("serializes nested JSON strings and matches VLESS + REALITY + vision expectations", () => {
    const body = buildVlessRealityInboundBody({
      port: 4433,
      remark: "rm1",
      clientEmail: "u1@example.com",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "a1b2c3d4e5f6789a",
      shortId: "01234567",
      realityPrivateKeyB64: Buffer.alloc(32, 3).toString("base64url"),
      realityPublicKeyB64: Buffer.alloc(32, 5).toString("base64url"),
    });

    expect(body.protocol).toBe("vless");
    expect(body.port).toBe(4433);
    expect(body.remark).toBe("rm1");

    const settings = JSON.parse(body.settings) as {
      clients: Array<{ id: string; flow: string; email: string; subId: string }>;
      decryption: string;
    };
    expect(settings.clients).toHaveLength(1);
    expect(settings.clients[0]!.flow).toBe("xtls-rprx-vision");
    expect(settings.clients[0]!.email).toBe("u1@example.com");
    expect(settings.clients[0]!.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(settings.clients[0]!.subId).toBe("a1b2c3d4e5f6789a");
    expect(settings.decryption).toBe("none");

    const stream = JSON.parse(body.streamSettings) as {
      network: string;
      security: string;
      realitySettings: {
        target: string;
        serverNames: string[];
        privateKey: string;
        settings: { publicKey: string };
        shortIds: string[];
      };
    };
    expect(stream.network).toBe("tcp");
    expect(stream.security).toBe("reality");
    expect(stream.realitySettings.target).toBe("yahoo.com:443");
    expect(stream.realitySettings.serverNames).toEqual(["yahoo.com"]);
    expect(stream.realitySettings.shortIds).toEqual(["01234567"]);
    expect(stream.realitySettings.privateKey).toBe(Buffer.alloc(32, 3).toString("base64url"));
    expect(stream.realitySettings.settings.publicKey).toBe(Buffer.alloc(32, 5).toString("base64url"));

    const sniff = JSON.parse(body.sniffing) as { enabled: boolean; destOverride: string[] };
    expect(sniff.enabled).toBe(true);
    expect(Array.isArray(sniff.destOverride)).toBe(true);
  });
});
