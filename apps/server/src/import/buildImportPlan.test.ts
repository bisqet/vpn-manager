import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ExportV2 } from "../export/buildExport";
import { migrate } from "../db/migrate";
import { buildImportPlan } from "./buildImportPlan";
import type { NormalizedImport } from "./parseImportDocument";

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
        defaultAction: "direct",
        rules: [],
      },
    ],
  };
  return { ...base, ...overrides };
}

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

function insertVpnProfile(db: Database, host: string, sshPort: number, sshUser: string): number {
  const empty = new Uint8Array(0);
  const result = db
    .query<{ id: number }, [string, string, number, string, Uint8Array, Uint8Array]>(
      `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get("test-profile", host, sshPort, sshUser, empty, empty);
  return result!.id;
}

describe("buildImportPlan", () => {
  test("single hop chain - link mode when profile exists", () => {
    const db = makeDb();
    const existingId = insertVpnProfile(db, "hop.example.com", 22, "root");
    const ex = minimalExportV2();
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.plan).not.toBeNull();

    const chain = result.plan!.chains[0]!;
    expect(chain.sourceIndex).toBe(0);
    expect(chain.hopCount).toBe(1);
    expect(chain.ruleCount).toBe(0);
    expect(chain.hops).toHaveLength(1);

    const hop = chain.hops[0]!;
    expect(hop.mode).toBe("link");
    expect(hop.existingProfileId).toBe(existingId);
    expect(hop.passwordKey).toBeUndefined();
    expect(hop.panelHostnameKey).toBeUndefined();

    expect(result.passwordKeys).toHaveLength(0);
    expect(result.panelHostnameKeys).toHaveLength(0);
  });

  test("two-hop chain - first hop link, second hop create with both keys", () => {
    const db = makeDb();
    const existingId = insertVpnProfile(db, "hop1.example.com", 22, "root");

    const ex = minimalExportV2({
      chainId: 5,
      chain: [
        { chainHopId: 10, profileId: 20, host: "hop1.example.com", sshPort: 22, sshUser: "root" },
        { chainHopId: 11, profileId: 21, host: "hop2.example.com", sshPort: 2222, sshUser: "admin" },
      ],
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: 10,
          routingProfileId: 30,
          defaultAction: "use_chain",
          rules: [],
        },
        {
          hopIndex: 1,
          chainHopId: 11,
          routingProfileId: 31,
          defaultAction: "direct",
          rules: [],
        },
      ],
    });

    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.errors).toHaveLength(0);

    const chain = result.plan!.chains[0]!;
    expect(chain.hopCount).toBe(2);
    expect(chain.hops).toHaveLength(2);

    const hop0 = chain.hops[0]!;
    expect(hop0.mode).toBe("link");
    expect(hop0.existingProfileId).toBe(existingId);
    expect(hop0.passwordKey).toBeUndefined();
    expect(hop0.panelHostnameKey).toBeUndefined();

    const hop1 = chain.hops[1]!;
    expect(hop1.mode).toBe("create");
    expect(hop1.existingProfileId).toBeUndefined();
    expect(hop1.passwordKey).toBe("newProfile:0:1");
    expect(hop1.panelHostnameKey).toBe("newProfile:0:1");

    expect(result.passwordKeys).toEqual(["newProfile:0:1"]);
    expect(result.panelHostnameKeys).toEqual(["newProfile:0:1"]);
  });

  test("single hop create - no existing profile, both keys emitted", () => {
    const db = makeDb();
    const ex = minimalExportV2({ chainId: 99 });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const hop = result.plan!.chains[0]!.hops[0]!;
    expect(hop.mode).toBe("create");
    expect(hop.passwordKey).toBe("newProfile:0:0");
    expect(hop.panelHostnameKey).toBe("newProfile:0:0");
    expect(result.passwordKeys).toContain("newProfile:0:0");
    expect(result.panelHostnameKeys).toContain("newProfile:0:0");
  });

  test("exportName set when export has a name", () => {
    const db = makeDb();
    const ex = minimalExportV2({ name: "my-chain" });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.plan!.chains[0]!.exportName).toBe("my-chain");
  });

  test("exportName omitted when export has no name", () => {
    const db = makeDb();
    const ex = minimalExportV2();
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.plan!.chains[0]!.exportName).toBeUndefined();
  });

  test("ruleCount counts rules across all hops", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      chain: [
        { chainHopId: 10, profileId: 20, host: "h1.example.com", sshPort: 22, sshUser: "u" },
        { chainHopId: 11, profileId: 21, host: "h2.example.com", sshPort: 22, sshUser: "u" },
      ],
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: 10,
          routingProfileId: 30,
          defaultAction: "use_chain",
          rules: [
            { matchKind: "domain", matchValue: ".example.com", action: "direct" },
            { matchKind: "cidr", matchValue: "10.0.0.0/8", action: "block" },
          ],
        },
        {
          hopIndex: 1,
          chainHopId: 11,
          routingProfileId: 31,
          defaultAction: "direct",
          rules: [{ matchKind: "domain", matchValue: ".ru", action: "block" }],
        },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.plan!.chains[0]!.ruleCount).toBe(3);
  });

  test("returns error when chain.length !== routingByHop.length", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      chain: [{ chainHopId: 10, profileId: 20, host: "h", sshPort: 22, sshUser: "u" }],
      routingByHop: [],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors.some((e) => e.includes("chain.length") || e.includes("routingByHop.length"))).toBe(true);
  });

  test("returns error when routingByHop hopIndex out of order", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      chain: [
        { chainHopId: 10, profileId: 20, host: "h1", sshPort: 22, sshUser: "u" },
        { chainHopId: 11, profileId: 21, host: "h2", sshPort: 22, sshUser: "u" },
      ],
      routingByHop: [
        { hopIndex: 1, chainHopId: 10, routingProfileId: 30, defaultAction: "use_chain", rules: [] },
        { hopIndex: 0, chainHopId: 11, routingProfileId: 31, defaultAction: "direct", rules: [] },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns error when terminal hop has defaultAction use_chain", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: 10,
          routingProfileId: 30,
          defaultAction: "use_chain",
          rules: [],
        },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal") || e.includes("use_chain"))).toBe(true);
  });

  test("returns error for invalid CIDR rule", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: 10,
          routingProfileId: 30,
          defaultAction: "direct",
          rules: [{ matchKind: "cidr", matchValue: "notacidr", action: "block" }],
        },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns error for invalid domain rule", () => {
    const db = makeDb();
    const ex = minimalExportV2({
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: 10,
          routingProfileId: 30,
          defaultAction: "direct",
          rules: [{ matchKind: "domain", matchValue: "nodot", action: "block" }],
        },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("warns when chain name collides with existing chain in DB", () => {
    const db = makeDb();
    db.exec("INSERT INTO chains (name) VALUES ('my-chain')");

    const ex = minimalExportV2({ name: "my-chain" });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.warnings.some((w) => w.includes("my-chain"))).toBe(true);
  });

  test("warns using fallback name imported-chain-{chainId} when no name", () => {
    const db = makeDb();
    db.exec("INSERT INTO chains (name) VALUES ('imported-chain-1')");

    const ex = minimalExportV2({ chainId: 1 });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    expect(result.warnings.some((w) => w.includes("imported-chain-1"))).toBe(true);
  });

  test("warnings are still returned even when there are errors", () => {
    const db = makeDb();
    db.exec("INSERT INTO chains (name) VALUES ('clash')");

    const ex = minimalExportV2({
      name: "clash",
      routingByHop: [
        { hopIndex: 0, chainHopId: 10, routingProfileId: 30, defaultAction: "use_chain", rules: [] },
      ],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("clash"))).toBe(true);
  });

  test("standalone VPN create - no password, no panelHostname → both keys", () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [],
      vpns: [{ label: "myVPN", host: "vpn.example.com", sshPort: 22, sshUser: "root" }],
    };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const vpn = result.plan!.standaloneVpns[0]!;
    expect(vpn.mode).toBe("create");
    expect(vpn.label).toBe("myVPN");
    expect(vpn.host).toBe("vpn.example.com");
    expect(vpn.passwordKey).toBe("vpn:0");
    expect(vpn.panelHostnameKey).toBe("vpn:0");
    expect(result.passwordKeys).toContain("vpn:0");
    expect(result.panelHostnameKeys).toContain("vpn:0");
  });

  test("standalone VPN create - has password, no panelHostname → only panelHostnameKey", () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [],
      vpns: [
        {
          label: "myVPN",
          host: "vpn.example.com",
          sshPort: 22,
          sshUser: "root",
          sshPassword: "secret",
        },
      ],
    };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const vpn = result.plan!.standaloneVpns[0]!;
    expect(vpn.mode).toBe("create");
    expect(vpn.passwordKey).toBeUndefined();
    expect(vpn.panelHostnameKey).toBe("vpn:0");
    expect(result.passwordKeys).toHaveLength(0);
    expect(result.panelHostnameKeys).toContain("vpn:0");
  });

  test("standalone VPN create - has panelHostname, no password → only passwordKey", () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [],
      vpns: [
        {
          label: "myVPN",
          host: "vpn.example.com",
          sshPort: 22,
          sshUser: "root",
          panelHostname: "panel.example.com",
        },
      ],
    };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const vpn = result.plan!.standaloneVpns[0]!;
    expect(vpn.mode).toBe("create");
    expect(vpn.passwordKey).toBe("vpn:0");
    expect(vpn.panelHostnameKey).toBeUndefined();
    expect(result.passwordKeys).toContain("vpn:0");
    expect(result.panelHostnameKeys).toHaveLength(0);
  });

  test("standalone VPN link - existing profile found", () => {
    const db = makeDb();
    const existingId = insertVpnProfile(db, "vpn.example.com", 22, "root");
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [],
      vpns: [
        {
          label: "myVPN",
          host: "vpn.example.com",
          sshPort: 22,
          sshUser: "root",
          panelHostname: "panel.example.com",
        },
      ],
    };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const vpn = result.plan!.standaloneVpns[0]!;
    expect(vpn.mode).toBe("link");
    expect(vpn.existingProfileId).toBe(existingId);
    expect(vpn.passwordKey).toBeUndefined();
    expect(vpn.panelHostnameKey).toBeUndefined();
    expect(result.passwordKeys).toHaveLength(0);
    expect(result.panelHostnameKeys).toHaveLength(0);
  });

  test("passwordKeys and panelHostnameKeys are sorted unique", () => {
    const db = makeDb();
    const ex1 = minimalExportV2({ chainId: 1, exportedAt: "2024-01-01T00:00:00.000Z" });
    const ex2 = minimalExportV2({
      chainId: 2,
      exportedAt: "2024-01-02T00:00:00.000Z",
      chain: [{ chainHopId: 20, profileId: 30, host: "hop2.example.com", sshPort: 22, sshUser: "u" }],
      routingByHop: [{ hopIndex: 0, chainHopId: 20, routingProfileId: 40, defaultAction: "direct", rules: [] }],
    });
    const normalized: NormalizedImport = { schemaVersion: 3, chains: [ex1, ex2], vpns: [] };
    const result = buildImportPlan(db, normalized);

    expect(result.canApply).toBe(true);
    const pw = result.passwordKeys;
    expect(pw).toEqual([...pw].sort());
    expect(new Set(pw).size).toBe(pw.length);
  });
});
