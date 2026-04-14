import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import { resolveProfileSetupTerminal } from "./profileSetupTerminalGate";

const MASTER_KEY = new Uint8Array(32).fill(1);

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE vpn_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT 'test',
      host TEXT NOT NULL DEFAULT '10.0.0.1',
      ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_user TEXT NOT NULL DEFAULT 'root',
      ssh_password_ciphertext BLOB NOT NULL,
      ssh_password_nonce BLOB NOT NULL,
      operational_status TEXT NOT NULL DEFAULT 'pending',
      panel_hostname TEXT NOT NULL DEFAULT ''
    )
  `);
  return db;
}

async function insertProfile(
  db: Database,
  overrides: {
    operational_status?: string;
    panel_hostname?: string;
  } = {},
): Promise<number> {
  const { ciphertext, nonce } = await encryptVpnPassword(MASTER_KEY, "testpass");
  const status = overrides.operational_status ?? "pending";
  const hostname = overrides.panel_hostname ?? "example.com";
  db.run(
    `INSERT INTO vpn_profiles (ssh_password_ciphertext, ssh_password_nonce, operational_status, panel_hostname)
     VALUES (?, ?, ?, ?)`,
    [ciphertext, nonce, status, hostname],
  );
  return (db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!).id;
}

const BASE_ARGS = {
  masterKey: MASTER_KEY,
  vpnSshEnabled: true,
  userId: 1 as number | null,
};

describe("resolveProfileSetupTerminal", () => {
  test("returns 401 when userId is null", async () => {
    const db = makeDb();
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      userId: null,
      profileId: 1,
    });
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("returns 403 when vpnSshEnabled is false", async () => {
    const db = makeDb();
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      vpnSshEnabled: false,
      profileId: 1,
    });
    expect(result).toEqual({ ok: false, status: 403 });
  });

  test("returns 400 for profileId of 0", async () => {
    const db = makeDb();
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: 0,
    });
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test("returns 400 for negative profileId", async () => {
    const db = makeDb();
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: -5,
    });
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test("returns 404 when profile does not exist", async () => {
    const db = makeDb();
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: 999,
    });
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test("returns 409 when operational_status is 'working'", async () => {
    const db = makeDb();
    const id = await insertProfile(db, { operational_status: "working" });
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: id,
    });
    expect(result).toEqual({ ok: false, status: 409 });
  });

  test("returns 400 when panel_hostname is empty string", async () => {
    const db = makeDb();
    const id = await insertProfile(db, { panel_hostname: "" });
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: id,
    });
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test("returns 400 when panel_hostname is only whitespace", async () => {
    const db = makeDb();
    const id = await insertProfile(db, { panel_hostname: "   " });
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: id,
    });
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test("returns ok:true with decrypted sshPassword for valid pending profile", async () => {
    const db = makeDb();
    const id = await insertProfile(db, { panel_hostname: "vpn.example.com" });
    const result = await resolveProfileSetupTerminal({
      ...BASE_ARGS,
      db,
      profileId: id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sshPassword).toBe("testpass");
      expect(result.row.panel_hostname).toBe("vpn.example.com");
      expect(result.row.operational_status).toBe("pending");
      expect(result.row.id).toBe(id);
    }
  });
});
