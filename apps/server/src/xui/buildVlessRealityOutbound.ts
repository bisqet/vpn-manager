export type VlessRealityOutboundInput = {
  tag: string;
  address: string;
  port: number;
  uuid: string;
  publicKey: string;
  shortId: string;
};

/** Xray outbound JSON fragment for VLESS + REALITY + xtls-rprx-vision (client to next hop). */
export function buildVlessRealityOutbound(input: VlessRealityOutboundInput): Record<string, unknown> {
  return {
    tag: input.tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: input.address,
          port: input.port,
          users: [
            {
              id: input.uuid,
              encryption: "none",
              flow: "xtls-rprx-vision",
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      tcpSettings: {
        header: { type: "none" },
      },
      realitySettings: {
        serverName: "yahoo.com",
        fingerprint: "chrome",
        publicKey: input.publicKey,
        shortId: input.shortId,
        spiderX: "/",
      },
    },
  };
}
