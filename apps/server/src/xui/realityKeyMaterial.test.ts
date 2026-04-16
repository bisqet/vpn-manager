import { describe, expect, test } from "bun:test";
import { generateRealityClientMaterial, randomRealityShortId, randomSubId } from "./realityKeyMaterial";

function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

describe("generateRealityClientMaterial", () => {
  test("returns unique clientUuid per call", async () => {
    const a = await generateRealityClientMaterial();
    const b = await generateRealityClientMaterial();
    expect(a.clientUuid).not.toBe(b.clientUuid);
  });

  test("returns non-empty base64 x25519 keys of 32 raw bytes", async () => {
    const m = await generateRealityClientMaterial();
    expect(m.realityPrivateKeyB64.length).toBeGreaterThan(0);
    expect(m.realityPublicKeyB64.length).toBeGreaterThan(0);
    const priv = decodeBase64(m.realityPrivateKeyB64);
    const pub = decodeBase64(m.realityPublicKeyB64);
    expect(priv.byteLength).toBe(32);
    expect(pub.byteLength).toBe(32);
  });

  test("subId has expected length and charset", async () => {
    const m = await generateRealityClientMaterial();
    expect(m.subId.length).toBe(16);
    expect(m.subId).toMatch(/^[a-z0-9]{16}$/);
  });

  test("shortId is even-length hex within REALITY short id bounds", async () => {
    const m = await generateRealityClientMaterial();
    expect(m.shortId.length % 2).toBe(0);
    expect(m.shortId.length).toBeGreaterThanOrEqual(2);
    expect(m.shortId.length).toBeLessThanOrEqual(16);
    expect(m.shortId).toMatch(/^[0-9a-f]+$/);
  });
});

describe("randomSubId", () => {
  test("honors length", () => {
    expect(randomSubId(12).length).toBe(12);
  });
});

describe("randomRealityShortId", () => {
  test("produces 8 hex chars", () => {
    expect(randomRealityShortId().length).toBe(8);
  });
});
