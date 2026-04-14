import { decryptVpnPassword, encryptVpnPassword } from "./vpnSecret";

export type XuiSecretsPayloadV1 = {
  v: 1;
  adminUsername: string;
  adminPassword: string;
};

export async function encryptXuiSecretsJson(
  masterKey: Uint8Array,
  payload: XuiSecretsPayloadV1,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  return encryptVpnPassword(masterKey, JSON.stringify(payload));
}

export async function decryptXuiSecretsJson(
  masterKey: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Promise<XuiSecretsPayloadV1> {
  const text = await decryptVpnPassword(masterKey, ciphertext, nonce);
  return JSON.parse(text) as XuiSecretsPayloadV1;
}
