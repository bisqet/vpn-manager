import { describe, expect, test } from "bun:test";
import {
  MAX_MERGE_ROOTS,
  mergeParsedRootsToImportJson,
} from "./mergeImportSources";

function minimalExportV2(chainId: number, exportedAt: string, hopId: number): Record<string, unknown> {
  return {
    schemaVersion: 2,
    exportedAt,
    chainId,
    chain: [
      {
        chainHopId: hopId,
        profileId: 1,
        host: "192.0.2.1",
        sshPort: 22,
        sshUser: "root",
      },
    ],
    routingByHop: [
      {
        hopIndex: 0,
        chainHopId: hopId,
        routingProfileId: 1,
        defaultAction: "direct",
        rules: [],
      },
    ],
  };
}

describe("mergeParsedRootsToImportJson", () => {
  test("two v2 roots merge into v3 with two chains", () => {
    const a = minimalExportV2(1, "2020-01-01T00:00:00.000Z", 10);
    const b = minimalExportV2(2, "2020-01-02T00:00:00.000Z", 20);
    const r = mergeParsedRootsToImportJson([a, b]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.json.schemaVersion).toBe(3);
    expect(r.json.chains.length).toBe(2);
    expect(r.json.vpns.length).toBe(0);
    expect(r.json.chains[0]).toEqual(a);
    expect(r.json.chains[1]).toEqual(b);
  });

  test("two v3 roots concatenate chains and vpns in order", () => {
    const c1 = minimalExportV2(1, "2020-01-01T00:00:00.000Z", 1);
    const c2 = minimalExportV2(2, "2020-01-02T00:00:00.000Z", 2);
    const v1 = { label: "a", host: "192.0.2.1", sshPort: 22, sshUser: "u1", panelHostname: "panel1.example.com" };
    const v2 = { label: "b", host: "192.0.2.2", sshPort: 22, sshUser: "u2", panelHostname: "panel2.example.com" };
    const r = mergeParsedRootsToImportJson([
      { schemaVersion: 3, chains: [c1], vpns: [v1] },
      { schemaVersion: 3, chains: [c2], vpns: [v2] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.json.chains).toEqual([c1, c2]);
    expect(r.json.vpns).toEqual([v1, v2]);
  });

  test("duplicate chainId + exportedAt across merged chains fails", () => {
    const dupAt = "2020-01-01T00:00:00.000Z";
    const a = minimalExportV2(42, dupAt, 1);
    const b = minimalExportV2(42, dupAt, 2);
    const r = mergeParsedRootsToImportJson([a, b]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain("Duplicate chain export (same chainId and exportedAt).");
  });

  test("more than MAX_MERGE_ROOTS roots fails before merge", () => {
    const roots = Array.from({ length: MAX_MERGE_ROOTS + 1 }, () => ({
      schemaVersion: 3,
      chains: [],
      vpns: [{ label: "x", host: "192.0.2.1", sshPort: 22, sshUser: "u", panelHostname: "p.example.com" }],
    }));
    const r = mergeParsedRootsToImportJson(roots);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("50");
    expect(r.errors[0]).toContain("51");
  });
});
