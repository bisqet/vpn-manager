import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../db/migrate";
import type { NormalizedImport } from "./parseImportDocument";
import { applyImport } from "./applyImport";
import type { ExportV2 } from "../export/buildExport";

const MASTER_KEY = new Uint8Array(32).fill(7);
const env = { masterKey: MASTER_KEY };

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function minimalExportV2(overrides: Partial<ExportV2> = {}): ExportV2 {
  const base: ExportV2 = {
    schemaVersion: 2,
    exportedAt: "2024-06-01T00:00:00.000Z",
    chainId: 1,
    chain: [
      { chainHopId: 10, profileId: 20, host: "hop.example.com", sshPort: 22, sshUser: "root" },
    ],
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

function countRows(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

describe("applyImport", () => {
  test("single-hop chain: creates chain, profile, routing_profile", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [minimalExportV2({ name: "my-import" })],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: { "newProfile:0:0": "secret123" },
      panelHostnames: { "newProfile:0:0": "panel.example.com" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.chainIds).toHaveLength(1);
    expect(result.profileIds).toHaveLength(1);

    expect(countRows(db, "chains")).toBe(1);
    expect(countRows(db, "vpn_profiles")).toBe(1);
    expect(countRows(db, "chain_hops")).toBe(1);
    expect(countRows(db, "routing_profiles")).toBe(1);

    const chain = db
      .query<{ name: string }, []>("SELECT name FROM chains LIMIT 1")
      .get()!;
    expect(chain.name).toBe("my-import");
  });

  test("routing rules are inserted from export", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [
        minimalExportV2({
          name: "chain-with-rules",
          routingByHop: [
            {
              hopIndex: 0,
              chainHopId: 10,
              routingProfileId: 30,
              defaultAction: "direct",
              rules: [
                { matchKind: "cidr", matchValue: "10.0.0.0/8", action: "block" },
                { matchKind: "domain", matchValue: ".example.com", action: "direct" },
              ],
            },
          ],
        }),
      ],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: { "newProfile:0:0": "pw" },
      panelHostnames: { "newProfile:0:0": "panel.example.com" },
    });

    expect(result.ok).toBe(true);
    expect(countRows(db, "rules")).toBe(2);

    const rules = db
      .query<
        { position: number; match_kind: string; match_value: string; action: string },
        []
      >("SELECT position, match_kind, match_value, action FROM rules ORDER BY position ASC")
      .all();

    expect(rules[0]!.match_kind).toBe("cidr");
    expect(rules[0]!.match_value).toBe("10.0.0.0/8");
    expect(rules[0]!.action).toBe("block");
    expect(rules[0]!.position).toBe(0);

    expect(rules[1]!.match_kind).toBe("domain");
    expect(rules[1]!.action).toBe("direct");
    expect(rules[1]!.position).toBe(1);
  });

  test("missing password returns ok:false before any DB rows are written", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [minimalExportV2()],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: {},
      panelHostnames: { "newProfile:0:0": "panel.example.com" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/password/i);
    expect(result.status).toBe(400);

    expect(countRows(db, "chains")).toBe(0);
    expect(countRows(db, "vpn_profiles")).toBe(0);
  });

  test("missing panelHostname returns ok:false with no partial rows", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [minimalExportV2()],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: { "newProfile:0:0": "pw" },
      panelHostnames: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/panelHostname/i);

    expect(countRows(db, "chains")).toBe(0);
    expect(countRows(db, "vpn_profiles")).toBe(0);
  });

  test("invalid plan (canApply false) returns ok:false with status 422", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [
        minimalExportV2({
          routingByHop: [
            {
              hopIndex: 0,
              chainHopId: 10,
              routingProfileId: 30,
              defaultAction: "use_chain",
              rules: [],
            },
          ],
        }),
      ],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: {},
      panelHostnames: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });

  test("chain name collision gets a suffix", async () => {
    const db = makeDb();
    db.exec("INSERT INTO chains (name) VALUES ('my-chain')");

    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [minimalExportV2({ name: "my-chain" })],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: { "newProfile:0:0": "pw" },
      panelHostnames: { "newProfile:0:0": "panel.example.com" },
    });

    expect(result.ok).toBe(true);

    const names = db
      .query<{ name: string }, []>("SELECT name FROM chains ORDER BY id ASC")
      .all()
      .map((r) => r.name);

    expect(names).toContain("my-chain");
    expect(names).toContain("my-chain (imported 2)");
  });

  test("hop in link mode reuses existing profile", async () => {
    const db = makeDb();
    const empty = new Uint8Array(0);
    const profileResult = db
      .query<{ id: number }, [string, string, number, string, Uint8Array, Uint8Array]>(
        `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get("existing", "hop.example.com", 22, "root", empty, empty)!;
    const existingId = profileResult.id;

    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [minimalExportV2({ name: "linked" })],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: {},
      panelHostnames: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(countRows(db, "vpn_profiles")).toBe(1);
    expect(result.profileIds).toHaveLength(0);

    const hop = db
      .query<{ vpn_profile_id: number }, []>(
        "SELECT vpn_profile_id FROM chain_hops LIMIT 1",
      )
      .get()!;
    expect(hop.vpn_profile_id).toBe(existingId);
  });

  test("standalone VPN create - uses password and panelHostname from maps", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [],
      vpns: [
        {
          label: "standalone",
          host: "vpn.example.com",
          sshPort: 22,
          sshUser: "root",
        },
      ],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: { "vpn:0": "mypassword" },
      panelHostnames: { "vpn:0": "panel.vpn.example.com" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profileIds).toHaveLength(1);
    expect(countRows(db, "vpn_profiles")).toBe(1);

    const profile = db
      .query<{ label: string; panel_hostname: string }, []>(
        "SELECT label, panel_hostname FROM vpn_profiles LIMIT 1",
      )
      .get()!;
    expect(profile.label).toBe("standalone");
    expect(profile.panel_hostname).toBe("panel.vpn.example.com");
  });

  test("two-hop chain: both profiles created, routing profiles set up", async () => {
    const db = makeDb();
    const normalized: NormalizedImport = {
      schemaVersion: 3,
      chains: [
        {
          schemaVersion: 2,
          exportedAt: "2024-06-01T00:00:00.000Z",
          chainId: 99,
          name: "two-hop",
          chain: [
            { chainHopId: 10, profileId: 20, host: "hop1.example.com", sshPort: 22, sshUser: "u1" },
            { chainHopId: 11, profileId: 21, host: "hop2.example.com", sshPort: 2222, sshUser: "u2" },
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
        },
      ],
      vpns: [],
    };

    const result = await applyImport({
      db,
      env,
      normalized,
      passwords: {
        "newProfile:0:0": "pw1",
        "newProfile:0:1": "pw2",
      },
      panelHostnames: {
        "newProfile:0:0": "panel1.example.com",
        "newProfile:0:1": "panel2.example.com",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profileIds).toHaveLength(2);
    expect(result.chainIds).toHaveLength(1);
    expect(countRows(db, "chain_hops")).toBe(2);
    expect(countRows(db, "routing_profiles")).toBe(2);

    const rpRows = db
      .query<{ default_action: string }, []>(
        `SELECT rp.default_action
         FROM routing_profiles rp
         JOIN chain_hops ch ON ch.id = rp.chain_hop_id
         ORDER BY ch.position ASC`,
      )
      .all();

    expect(rpRows[0]!.default_action).toBe("use_chain");
    expect(rpRows[1]!.default_action).toBe("direct");
  });
});
