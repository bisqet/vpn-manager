import { describe, expect, test } from "bun:test";
import { decryptXuiSecretsJson, encryptXuiSecretsJson } from "./xuiSecrets";

describe("xuiSecrets", () => {
  test("roundtrips json payload", async () => {
    const masterKey = new Uint8Array(32).fill(7);
    const payload = { v: 1 as const, adminUsername: "u9", adminPassword: "p-secret-!" };
    const enc = await encryptXuiSecretsJson(masterKey, payload);
    const out = await decryptXuiSecretsJson(masterKey, enc.ciphertext, enc.nonce);
    expect(out).toEqual(payload);
  });
});
