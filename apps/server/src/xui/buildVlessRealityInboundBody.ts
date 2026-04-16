const VISION_FLOW = "xtls-rprx-vision";
const REALITY_DEST_HOST = "yahoo.com";
const REALITY_TARGET = `${REALITY_DEST_HOST}:443`;

export type VlessRealityInboundInput = {
  port: number;
  remark: string;
  clientEmail: string;
  clientUuid: string;
  subId: string;
  shortId: string;
  realityPrivateKeyB64: string;
  realityPublicKeyB64: string;
};

/**
 * Body for `POST /panel/api/inbounds/add` on 3x-ui (MHSanaei/3x-ui): nested Xray JSON is sent as strings
 * (`settings`, `streamSettings`, `sniffing`) per `model.Inbound`.
 */
export type VlessRealityInboundAddBody = {
  remark: string;
  listen: string;
  port: number;
  protocol: "vless";
  enable: boolean;
  settings: string;
  streamSettings: string;
  sniffing: string;
  total: number;
  expiryTime: number;
  trafficReset: string;
};

export function buildVlessRealityInboundBody(input: VlessRealityInboundInput): VlessRealityInboundAddBody {
  const settingsObj = {
    clients: [
      {
        id: input.clientUuid,
        flow: VISION_FLOW,
        email: input.clientEmail,
        limitIp: 0,
        totalGB: 0,
        expiryTime: 0,
        enable: true,
        tgId: 0,
        subId: input.subId,
        comment: "",
        reset: 0,
      },
    ],
    decryption: "none",
    encryption: "none",
    testseed: [900, 500, 900, 256],
  };

  const streamSettingsObj = {
    network: "tcp",
    security: "reality",
    externalProxy: [],
    realitySettings: {
      show: false,
      xver: 0,
      target: REALITY_TARGET,
      serverNames: [REALITY_DEST_HOST],
      privateKey: input.realityPrivateKeyB64,
      minClientVer: "",
      maxClientVer: "",
      maxTimediff: 0,
      shortIds: [input.shortId],
      mldsa65Seed: "",
      settings: {
        publicKey: input.realityPublicKeyB64,
        fingerprint: "chrome",
        serverName: "",
        spiderX: "/",
        mldsa65Verify: "",
      },
    },
    tcpSettings: {
      acceptProxyProtocol: false,
      header: {
        type: "none",
      },
    },
  };

  const sniffingObj = {
    enabled: true,
    destOverride: ["http", "tls", "quic", "fakedns"],
    metadataOnly: false,
    routeOnly: false,
  };

  return {
    remark: input.remark,
    listen: "",
    port: input.port,
    protocol: "vless",
    enable: true,
    total: 0,
    expiryTime: 0,
    trafficReset: "never",
    settings: JSON.stringify(settingsObj),
    streamSettings: JSON.stringify(streamSettingsObj),
    sniffing: JSON.stringify(sniffingObj),
  };
}
