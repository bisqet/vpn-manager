const ALGO = "AES-GCM";
const IV_LENGTH = 12;

function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: ALGO }, false, ["encrypt", "decrypt"]);
}

export async function encryptVpnPassword(
  masterKey: Uint8Array,
  plaintext: string
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const cryptoKey = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const enc = new TextEncoder().encode(plaintext);
  const buf = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv }, cryptoKey, enc)
  );
  return { ciphertext: buf, nonce: iv };
}

export async function decryptVpnPassword(
  masterKey: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array
): Promise<string> {
  const cryptoKey = await importKey(masterKey);
  const dec = await crypto.subtle.decrypt({ name: ALGO, iv: nonce }, cryptoKey, ciphertext);
  return new TextDecoder().decode(dec);
}
