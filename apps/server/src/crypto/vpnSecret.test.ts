import { describe, test, expect } from "bun:test";
import { encryptVpnPassword, decryptVpnPassword } from "./vpnSecret";

const key = new Uint8Array(32);
key.fill(7);

describe("vpnSecret", () => {
  test("roundtrip", async () => {
    const secret = "hunter2";
    const { ciphertext, nonce } = await encryptVpnPassword(key, secret);
    const out = await decryptVpnPassword(key, ciphertext, nonce);
    expect(out).toBe(secret);
  });
});
