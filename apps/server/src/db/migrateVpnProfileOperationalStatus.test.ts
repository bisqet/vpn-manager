import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateVpnProfileOperationalStatusIfNeeded } from "./migrateVpnProfileOperationalStatus";

describe("migrateVpnProfileOperationalStatusIfNeeded", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
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
    `);
    db.query(
      `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("A", "h", 22, "u", new Uint8Array([1]), new Uint8Array([2]));
  });

  test("adds operational_status defaulting existing rows to pending", () => {
    migrateVpnProfileOperationalStatusIfNeeded(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all();
    expect(cols.map((c) => c.name)).toContain("operational_status");

    const status = db
      .query<{ operational_status: string }, []>("SELECT operational_status FROM vpn_profiles WHERE id = 1")
      .get();
    expect(status?.operational_status).toBe("pending");
  });
});
