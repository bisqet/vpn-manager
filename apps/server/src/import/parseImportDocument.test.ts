import { describe, expect, test } from "bun:test";
import type { ExportV2 } from "../export/buildExport";
import { MAX_IMPORT_BYTES, parseImportDocument } from "./parseImportDocument";

function minimalExportV2(overrides: Partial<ExportV2> = {}): ExportV2 {
  const base: ExportV2 = {
    schemaVersion: 2,
    exportedAt: "2024-01-01T00:00:00.000Z",
    chainId: 1,
    chain: [{ chainHopId: 10, profileId: 20, host: "hop.example.com", sshPort: 22, sshUser: "root" }],
    routingByHop: [
      {
        hopIndex: 0,
        chainHopId: 10,
        routingProfileId: 30,
        defaultAction: "use_chain",
        rules: [{ matchKind: "domain", matchValue: "example.com", action: "direct" }],
      },
    ],
  };
  return { ...base, ...overrides };
}

describe("parseImportDocument", () => {
  test("v3 with empty chains and vpns fails", () => {
    const r = parseImportDocument(JSON.stringify({ schemaVersion: 3, chains: [], vpns: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.toLowerCase().includes("empty"))).toBe(true);
  });

  test("v3 chains only", () => {
    const ex = minimalExportV2({ chainId: 7, exportedAt: "2025-06-01T12:00:00.000Z" });
    const r = parseImportDocument(JSON.stringify({ schemaVersion: 3, chains: [ex] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.schemaVersion).toBe(3);
      expect(r.normalized.chains).toEqual([ex]);
      expect(r.normalized.vpns).toEqual([]);
    }
  });

  test("v3 vpns only", () => {
    const doc = {
      schemaVersion: 3,
      vpns: [
        {
          label: "edge",
          host: "203.0.113.10",
          sshPort: 2200,
          sshUser: "deploy",
          panelHostname: "panel.example.com",
        },
      ],
    };
    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.chains).toEqual([]);
      expect(r.normalized.vpns).toEqual(doc.vpns);
    }
  });

  test("v2 export at root normalizes to v3", () => {
    const ex = minimalExportV2({ name: "Primary" });
    const r = parseImportDocument(JSON.stringify(ex));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toEqual({
        schemaVersion: 3,
        chains: [ex],
        vpns: [],
      });
    }
  });

  test("bare VPN valid", () => {
    const r = parseImportDocument(
      JSON.stringify({
        host: "vpn.example.com",
        sshPort: 22,
        sshUser: "root",
        panelHostname: "panel.vpn.example.com",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.chains).toEqual([]);
      expect(r.normalized.vpns).toEqual([
        {
          label: "vpn.example.com",
          host: "vpn.example.com",
          sshPort: 22,
          sshUser: "root",
          panelHostname: "panel.vpn.example.com",
        },
      ]);
    }
  });

  test("strips UTF-8 BOM", () => {
    const ex = minimalExportV2();
    const json = JSON.stringify({ schemaVersion: 3, chains: [ex] });
    const r = parseImportDocument(`\uFEFF${json}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.chains).toHaveLength(1);
  });

  test("unknown numeric schemaVersion", () => {
    const r = parseImportDocument(JSON.stringify({ schemaVersion: 99, host: "x", sshUser: "u", sshPort: 22 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("unknown schemaVersion");
  });

  test("ambiguous object with non-empty chain array and no schema v2", () => {
    const r = parseImportDocument(
      JSON.stringify({
        chain: [{ chainHopId: 1, profileId: 1, host: "h", sshPort: 22, sshUser: "u" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  test("duplicate chainId and exportedAt in v3.chains fails", () => {
    const ex = minimalExportV2({ chainId: 5, exportedAt: "2024-02-02T00:00:00.000Z" });
    const r = parseImportDocument(JSON.stringify({ schemaVersion: 3, chains: [ex, { ...ex, name: "copy" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ").toLowerCase()).toContain("duplicate");
  });

  test("rejects when text exceeds MAX_IMPORT_BYTES", () => {
    const filler = "x".repeat(MAX_IMPORT_BYTES);
    const r = parseImportDocument(`{"schemaVersion":3,"chains":[],"vpns":[],"pad":"${filler}"}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ").toLowerCase()).toMatch(/byte|size|limit|large|exceed/i);
  });
});
