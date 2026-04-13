import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateRoutingDefaultActionsIfNeeded } from "./migrateRoutingDefaultActions";

function createDbWithTwoValueCheck() {
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
      chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE,
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
  const vp = Number(
    db
      .query(
        `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("A", "a.example.com", 22, "u", new Uint8Array([1]), new Uint8Array([2])).lastInsertRowid,
  );
  const vp2 = Number(
    db
      .query(
        `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("B", "b.example.com", 22, "u", new Uint8Array([3]), new Uint8Array([4])).lastInsertRowid,
  );
  const chainId = Number(db.query("INSERT INTO chains (name) VALUES (?)").run("C").lastInsertRowid);
  const hop0 = Number(db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 0, vp).lastInsertRowid);
  const hop1 = Number(db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 1, vp2).lastInsertRowid);
  const rp0 = Number(
    db
      .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
      .run("p0", hop0, "use_chain").lastInsertRowid,
  );
  const rp1 = Number(
    db
      .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
      .run("p1", hop1, "use_chain").lastInsertRowid,
  );
  db.query(
    "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
  ).run(rp0, 0, "domain", ".a", "direct");
  db.query(
    "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
  ).run(rp1, 0, "domain", ".b", "block");
  return { db, hop0, hop1 };
}

test("widens CHECK, allows block, coerces terminal use_chain to direct", () => {
  const { db, hop0, hop1 } = createDbWithTwoValueCheck();

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM rules").get()).toEqual({ c: 2 });

  migrateRoutingDefaultActionsIfNeeded(db);

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM rules").get()).toEqual({ c: 2 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

  const rows = db
    .query<{ chain_hop_id: number; default_action: string }, []>(
      "SELECT chain_hop_id, default_action FROM routing_profiles ORDER BY chain_hop_id ASC",
    )
    .all();
  expect(rows).toEqual([
    { chain_hop_id: hop0, default_action: "use_chain" },
    { chain_hop_id: hop1, default_action: "direct" },
  ]);

  db.query("UPDATE routing_profiles SET default_action = ? WHERE chain_hop_id = ?").run("block", hop0);
  expect(
    db.query<{ default_action: string }, [number]>("SELECT default_action FROM routing_profiles WHERE chain_hop_id = ?").get(hop0),
  ).toEqual({ default_action: "block" });

  migrateRoutingDefaultActionsIfNeeded(db);
  expect(
    db
      .query<{ chain_hop_id: number; default_action: string }, []>(
        "SELECT chain_hop_id, default_action FROM routing_profiles ORDER BY chain_hop_id ASC",
      )
      .all(),
  ).toEqual([
    { chain_hop_id: hop0, default_action: "block" },
    { chain_hop_id: hop1, default_action: "direct" },
  ]);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM rules").get()).toEqual({ c: 2 });
});
