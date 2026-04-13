import { describe, test, expect } from "bun:test";
import { decodeMasterKey } from "./masterKey";

describe("decodeMasterKey", () => {
  test("decodes valid base64 32 bytes", () => {
    const raw = new Uint8Array(32);
    raw[0] = 9;
    const b64 = Buffer.from(raw).toString("base64");
    const key = decodeMasterKey(b64);
    expect(key.length).toBe(32);
    expect(key[0]).toBe(9);
  });

  test("throws on wrong length", () => {
    expect(() => decodeMasterKey(Buffer.from("short").toString("base64"))).toThrow();
  });
});
