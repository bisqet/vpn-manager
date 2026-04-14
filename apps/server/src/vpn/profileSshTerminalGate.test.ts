import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import { migrate } from "../db/migrate";
import { resolveProfileSshTerminal } from "./profileSshTerminalGate";

const masterKey = new Uint8Array(32).fill(7);

describe("resolveProfileSshTerminal", () => {
  let db: Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    const { ciphertext, nonce } = await encryptVpnPassword(masterKey, "secret");
    db.query(
      `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname, operational_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("P", "10.0.0.5", 22, "root", ciphertext, nonce, "panel.example.com", "pending");
  });

  test("401 when userId is null", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: null,
      profileId: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("403 when VPN_SSH_ENABLED is false", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: false,
      userId: 1,
      profileId: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test("400 when profile id invalid", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test("404 when profile missing", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 99,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  test("200 returns row and decrypted password when allowed", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.host).toBe("10.0.0.5");
      expect(r.sshPassword).toBe("secret");
    }
  });
});
