const X25519_PKCS8_PREFIX_LEN = 16;

function bytesToStdBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function extractX25519SeedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length < X25519_PKCS8_PREFIX_LEN + 32) {
    throw new Error("unexpected PKCS#8 length for X25519");
  }
  return pkcs8.subarray(pkcs8.length - 32);
}

const SUB_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomSubId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) {
    s += SUB_ID_ALPHABET[bytes[i]! % SUB_ID_ALPHABET.length]!;
  }
  return s;
}

/** REALITY shortId: even-length hex string (here 8 hex chars = 4 bytes). */
export function randomRealityShortId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type RealityClientMaterial = {
  clientUuid: string;
  subId: string;
  shortId: string;
  realityPrivateKeyB64: string;
  realityPublicKeyB64: string;
};

export async function generateRealityClientMaterial(): Promise<RealityClientMaterial> {
  const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const seed = extractX25519SeedFromPkcs8(pkcs8);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  return {
    clientUuid: crypto.randomUUID(),
    subId: randomSubId(16),
    shortId: randomRealityShortId(),
    realityPrivateKeyB64: bytesToStdBase64(seed),
    realityPublicKeyB64: bytesToStdBase64(pubRaw),
  };
}
