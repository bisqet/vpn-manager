import { describe, test, expect } from "bun:test";
import { assertValidCidr } from "./cidr";

describe("assertValidCidr", () => {
  test("accepts ipv4 cidr", () => {
    expect(() => assertValidCidr("10.0.0.0/8")).not.toThrow();
  });

  test("rejects host bits set", () => {
    expect(() => assertValidCidr("10.0.0.1/8")).toThrow();
  });

  test("accepts ipv6 cidr", () => {
    expect(() => assertValidCidr("2001:db8::/32")).not.toThrow();
  });
});
