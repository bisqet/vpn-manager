export function decodeMasterKey(base64: string): Uint8Array {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32) {
    throw new Error("VPN_MANAGER_MASTER_KEY must decode to exactly 32 bytes (base64)");
  }
  return new Uint8Array(buf);
}
