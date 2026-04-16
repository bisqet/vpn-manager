import { randomBytes } from "node:crypto";

const XUI_ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Shell-safe segment for x-ui paths and credentials (matches prior `randomAlnum` in recover). */
export function randomXuiAlnum(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += XUI_ALNUM[bytes[i]! % XUI_ALNUM.length]!;
  }
  return out;
}
