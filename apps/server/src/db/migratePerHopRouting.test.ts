import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migratePerHopRoutingIfNeeded } from "./migratePerHopRouting";

function createLegacyRoutingDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE chains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE vpn_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      ssh_port INTEGER NOT NULL,
      ssh_user TEXT NOT NULL,
      ssh_password_ciphertext BLOB NOT NULL,
      ssh_password_nonce BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chain_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      vpn_profile_id INTEGER NOT NULL REFERENCES vpn_profiles(id) ON DELETE RESTRICT,
      UNIQUE (chain_id, position),
      UNIQUE (chain_id, vpn_profile_id)
    );
    CREATE TABLE routing_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      chain_id INTEGER NOT NULL UNIQUE REFERENCES chains(id) ON DELETE CASCADE,
      default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct'))
    );
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routing_profile_id INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('domain','cidr')),
      match_value TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('direct','use_chain','block')),
      UNIQUE (routing_profile_id, position)
    );
  `);

  const insertVp = () =>
    Number(
      db
        .query(
          `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("A", "a.example.com", 22, "u", new Uint8Array([1]), new Uint8Array([2])).lastInsertRowid,
    );
  const vp1 = insertVp();
  const vp2 = insertVp();
  const chainId = Number(db.query("INSERT INTO chains (name) VALUES (?)").run("C").lastInsertRowid);
  const hop1 = Number(
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 0, vp1)
      .lastInsertRowid,
  );
  const hop2 = Number(
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 1, vp2)
      .lastInsertRowid,
  );
  const rp = Number(
    db
      .query("INSERT INTO routing_profiles (name, chain_id, default_action) VALUES (?, ?, ?)")
      .run("C routing", chainId, "direct").lastInsertRowid,
  );
  db.query(
    "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
  ).run(rp, 0, "domain", ".x", "block");

  return { db, chainId, hop1, hop2, legacyProfileId: rp };
}

describe("migratePerHopRoutingIfNeeded", () => {
  test("splits legacy chain-level profile into per-hop profiles and copies rules", () => {
    const { db, hop1, hop2, legacyProfileId } = createLegacyRoutingDb();

    migratePerHopRoutingIfNeeded(db);

    expect(db.query("SELECT COUNT(*) AS c FROM routing_profiles").get() as { c: number }).toEqual({ c: 2 });

    const profiles = db
      .query<{ id: number; chain_hop_id: number }, []>(
        "SELECT id, chain_hop_id FROM routing_profiles ORDER BY chain_hop_id ASC",
      )
      .all();
    expect(profiles.map((p) => p.chain_hop_id).sort()).toEqual([hop1, hop2].sort());

    for (const p of profiles) {
      const rules = db
        .query<{ match_value: string }, [number]>(
          "SELECT match_value FROM rules WHERE routing_profile_id = ? ORDER BY position",
        )
        .all(p.id);
      expect(rules).toEqual([{ match_value: ".x" }]);
    }

    const pragma = db.query<{ name: string }, []>("PRAGMA table_info(routing_profiles)").all();
    expect(pragma.some((c) => c.name === "chain_id")).toBe(false);
    expect(legacyProfileId).toBe(profiles[0]!.id);
  });
});
