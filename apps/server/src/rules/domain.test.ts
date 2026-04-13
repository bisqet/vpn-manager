import { describe, test, expect } from "bun:test";
import { normalizeDomainSuffix, assertValidDomainRule } from "./domain";

describe("normalizeDomainSuffix", () => {
  test("trims and lowercases", () => {
    expect(normalizeDomainSuffix("  *.RU ")).toBe(".ru");
  });

  test("co.uk style preserved", () => {
    expect(normalizeDomainSuffix(".Co.Uk")).toBe(".co.uk");
  });
});

describe("assertValidDomainRule", () => {
  test("rejects without leading dot", () => {
    expect(() => assertValidDomainRule("ru")).toThrow();
  });
});
