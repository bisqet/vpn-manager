import { describe, test, expect } from "bun:test";
import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  test("hashPassword returns a string and verifyPassword accepts it", async () => {
    const hash = await hashPassword("secret-value");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(await verifyPassword("secret-value", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
