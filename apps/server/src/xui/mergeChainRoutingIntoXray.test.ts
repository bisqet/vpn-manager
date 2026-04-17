import { describe, expect, test } from "bun:test";
import {
  appendOutbound,
  findFreedomOutboundTag,
  mergeInboundToOutboundRule,
} from "./mergeChainRoutingIntoXray";

describe("findFreedomOutboundTag", () => {
  test("returns tag of first freedom outbound on typical direct fixture", () => {
    const xray = {
      outbounds: [
        { protocol: "blackhole", tag: "blocked" },
        {
          protocol: "freedom",
          tag: "direct",
          settings: { domainStrategy: "UseIP" },
        },
      ],
    };
    expect(findFreedomOutboundTag(xray)).toBe("direct");
  });

  test("returns direct when no outbounds", () => {
    expect(findFreedomOutboundTag({})).toBe("direct");
  });

  test("returns direct when no freedom outbound", () => {
    expect(
      findFreedomOutboundTag({
        outbounds: [{ protocol: "vless", tag: "proxy" }],
      }),
    ).toBe("direct");
  });
});

describe("mergeInboundToOutboundRule", () => {
  test("prepends routing rule to existing rules", () => {
    const xray: Record<string, unknown> = {
      routing: {
        domainStrategy: "AsIs",
        rules: [{ type: "field", network: "tcp", outboundTag: "direct" }],
      },
    };
    const merged = mergeInboundToOutboundRule({
      xray,
      inboundTag: "in-vpnmgr",
      outboundTag: "vpnmgr-chain",
    });
    expect(merged).not.toBe(xray);
    const rules = (merged.routing as Record<string, unknown>).rules as unknown[];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      type: "field",
      inboundTag: ["in-vpnmgr"],
      outboundTag: "vpnmgr-chain",
    });
    expect(rules[1]).toEqual({ type: "field", network: "tcp", outboundTag: "direct" });
    const origRules = (xray.routing as Record<string, unknown>).rules as unknown[];
    expect(origRules).toHaveLength(1);
  });

  test("initializes rules array when missing", () => {
    const xray: Record<string, unknown> = { routing: {} };
    const merged = mergeInboundToOutboundRule({
      xray,
      inboundTag: "in-1",
      outboundTag: "out-1",
    });
    const rules = (merged.routing as Record<string, unknown>).rules as unknown[];
    expect(rules).toEqual([
      { type: "field", inboundTag: ["in-1"], outboundTag: "out-1" },
    ]);
  });

  test("throws when routing is missing", () => {
    expect(() =>
      mergeInboundToOutboundRule({
        xray: { outbounds: [] },
        inboundTag: "in",
        outboundTag: "out",
      }),
    ).toThrow("xray.routing is required");
  });
});

describe("appendOutbound", () => {
  test("pushes outbound and clones xray", () => {
    const xray: Record<string, unknown> = { outbounds: [{ protocol: "freedom", tag: "direct" }] };
    const outbound = { protocol: "vless", tag: "hop" };
    const merged = appendOutbound({ xray, outbound });
    expect(merged).not.toBe(xray);
    expect(merged.outbounds).toEqual([
      { protocol: "freedom", tag: "direct" },
      { protocol: "vless", tag: "hop" },
    ]);
    expect((xray.outbounds as unknown[]).length).toBe(1);
  });

  test("initializes outbounds when missing", () => {
    const xray: Record<string, unknown> = {};
    const merged = appendOutbound({
      xray,
      outbound: { protocol: "freedom", tag: "direct" },
    });
    expect(merged.outbounds).toEqual([{ protocol: "freedom", tag: "direct" }]);
  });
});
