import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import { decryptVpnPassword, encryptVpnPassword } from "../crypto/vpnSecret";
import { migrate } from "../db/migrate";
import type { Env } from "../env";
import { createApp } from "../index";
import type { SshExecFn } from "../vpn/sshExec";

type ProfileRow = {
  id: number;
  label: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
  created_at: string;
  updated_at: string;
};

const env: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
  vpnSshEnabled: false,
  acmeEmail: undefined,
  sshKnownHostsFile: undefined,
};

describe("profilesRoutes", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    db.query("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", "hash");
    db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
      "session-token",
      1,
      Date.now() + 60_000,
    );
  });

  test("creates profile with derived panel when host is public IP and panelHostname omitted", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Pub",
        host: "203.0.113.20",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { panelHostname: string };
    expect(body.panelHostname).toBe("203.0.113.20");
  });

  test("rejects create when panelHostname omitted and host is not public IP", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "NoPanel",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid panelHostname on create", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Bad",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "not-a-fqdn",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("allows unauthenticated GET /api/profiles", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/profiles");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("creates, lists, updates, and deletes profiles without exposing passwords", async () => {
    const app = createApp(db, env);

    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Home",
        host: "vpn.example.com",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "hunter2",
        panelHostname: "panel.vpn.example.com",
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created).toEqual({
      id: 1,
      label: "Home",
      host: "vpn.example.com",
      sshPort: 22,
      sshUser: "root",
      panelHostname: "panel.vpn.example.com",
      operationalStatus: "pending",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(created.sshPassword).toBeUndefined();

    const storedAfterCreate = db
      .query<ProfileRow, [number]>(
        "SELECT id, label, host, ssh_port, ssh_user, operational_status, ssh_password_ciphertext, ssh_password_nonce, created_at, updated_at FROM vpn_profiles WHERE id = ?",
      )
      .get(1);
    expect(storedAfterCreate).toBeDefined();
    expect(storedAfterCreate!.operational_status).toBe("pending");
    expect(await decryptVpnPassword(env.masterKey, storedAfterCreate!.ssh_password_ciphertext, storedAfterCreate!.ssh_password_nonce)).toBe(
      "hunter2",
    );

    const listRes = await app.request("/api/profiles", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed).toEqual([created]);
    expect(listed[0].sshPassword).toBeUndefined();

    const patchWithoutPasswordRes = await app.request("/api/profiles/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Office",
      }),
    });

    expect(patchWithoutPasswordRes.status).toBe(200);
    const updatedWithoutPassword = await patchWithoutPasswordRes.json();
    expect(updatedWithoutPassword).toEqual({
      id: 1,
      label: "Office",
      host: "vpn.example.com",
      sshPort: 22,
      sshUser: "root",
      panelHostname: "panel.vpn.example.com",
      operationalStatus: "working",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const storedAfterLabelPatch = db
      .query<ProfileRow, [number]>(
        "SELECT id, label, host, ssh_port, ssh_user, operational_status, ssh_password_ciphertext, ssh_password_nonce, created_at, updated_at FROM vpn_profiles WHERE id = ?",
      )
      .get(1);
    expect(await decryptVpnPassword(env.masterKey, storedAfterLabelPatch!.ssh_password_ciphertext, storedAfterLabelPatch!.ssh_password_nonce)).toBe(
      "hunter2",
    );

    const patchWithPasswordRes = await app.request("/api/profiles/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        sshPassword: "new-secret",
      }),
    });

    expect(patchWithPasswordRes.status).toBe(200);
    const updatedWithPassword = await patchWithPasswordRes.json();
    expect(updatedWithPassword).toEqual({
      id: 1,
      label: "Office",
      host: "vpn.example.com",
      sshPort: 22,
      sshUser: "root",
      panelHostname: "panel.vpn.example.com",
      operationalStatus: "working",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(updatedWithPassword.sshPassword).toBeUndefined();

    const storedAfterPasswordPatch = db
      .query<ProfileRow, [number]>(
        "SELECT id, label, host, ssh_port, ssh_user, operational_status, ssh_password_ciphertext, ssh_password_nonce, created_at, updated_at FROM vpn_profiles WHERE id = ?",
      )
      .get(1);
    expect(await decryptVpnPassword(env.masterKey, storedAfterPasswordPatch!.ssh_password_ciphertext, storedAfterPasswordPatch!.ssh_password_nonce)).toBe(
      "new-secret",
    );

    const deleteRes = await app.request("/api/profiles/1", {
      method: "DELETE",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(db.query("SELECT id FROM vpn_profiles WHERE id = ?").get(1)).toBeNull();
  });

  test("returns a conflict error when deleting a profile referenced by a chain hop", async () => {
    const app = createApp(db, env);

    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Pinned",
        host: "vpn.example.com",
        sshPort: 2222,
        sshUser: "admin",
        sshPassword: "secret",
        panelHostname: "panel.pinned.example.com",
      }),
    });
    expect(createRes.status).toBe(201);

    db.query("INSERT INTO chains (name) VALUES (?)").run("Primary");
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 0, 1);

    const deleteRes = await app.request("/api/profiles/1", {
      method: "DELETE",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect([400, 409]).toContain(deleteRes.status);
    expect(await deleteRes.json()).toEqual({
      error: "Profile is in use by one or more chain hops",
    });
  });

  test("POST /api/profiles/:id/setup returns dry-run when VPN_SSH_ENABLED is false", async () => {
    const app = createApp(db, env);

    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Edge",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.edge.example.com",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.operationalStatus).toBe("pending");

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(200);
    const body = await setupRes.json();
    expect(body.profile.operationalStatus).toBe("pending");
    expect(body.setup.mode).toBe("dry-run");
    expect(body.setup.phases.length).toBeGreaterThanOrEqual(7);
    expect(body.setup.phases[0].id).toBe("preflight");

    const row = db.query<{ operational_status: string }, []>(
      "SELECT operational_status FROM vpn_profiles WHERE id = 1",
    ).get();
    expect(row?.operational_status).toBe("pending");
  });

  test("POST /api/profiles/:id/setup live path succeeds with fake ssh", async () => {
    const liveEnv: Env = {
      ...env,
      vpnSshEnabled: true,
      acmeEmail: "ops@example.com",
    };
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, liveEnv, { profiles: { sshExec: fakeSsh } });

    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Live",
        host: "10.0.0.2",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "secretpw",
        panelHostname: "panel.live.example.com",
      }),
    });

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(200);
    const body = await setupRes.json();
    expect(body.setup.mode).toBe("live");
    expect(body.profile.operationalStatus).toBe("working");
    const row = db
      .query<{ operational_status: string; xui_web_base_path: string | null }, []>(
        "SELECT operational_status, xui_web_base_path FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(row?.operational_status).toBe("working");
    expect(row?.xui_web_base_path).toBeTruthy();
  });

  test("POST /api/profiles/:id/setup returns 409 when already working", async () => {
    const app = createApp(db, env);
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "W",
        host: "1.1.1.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.w.example.com",
      }),
    });
    db.query("UPDATE vpn_profiles SET operational_status = 'working' WHERE id = 1").run();

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(409);
  });

  test("PATCH clears panel to derived value when panelHostname empty string and host public", async () => {
    const app = createApp(db, env);
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "A",
        host: "198.51.100.2",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.patch.example.com",
      }),
    });
    const patchRes = await app.request("/api/profiles/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({ host: "198.51.100.3", panelHostname: "" }),
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as { panelHostname: string; host: string };
    expect(body.host).toBe("198.51.100.3");
    expect(body.panelHostname).toBe("198.51.100.3");
  });

  test("PATCH runs placeholder verify and sets operationalStatus working", async () => {
    const app = createApp(db, env);
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "X",
        host: "1.2.3.4",
        sshPort: 22,
        sshUser: "u",
        sshPassword: "p",
        panelHostname: "panel.x.example.com",
      }),
    });

    const patchRes = await app.request("/api/profiles/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({ label: "Y" }),
    });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json();
    expect(body.operationalStatus).toBe("working");
  });

  async function insertVpnProfileId1ForSsh(database: Database) {
    const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, "pw");
    database
      .query(
        `INSERT INTO vpn_profiles (id, label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname, operational_status)
         VALUES (1, 'Ssh', '127.0.0.1', 22, 'root', ?, ?, 'panel.test', 'pending')`,
      )
      .run(ciphertext, nonce);
  }

  test("GET /api/profiles/1/ssh without session returns 401", async () => {
    await insertVpnProfileId1ForSsh(db);
    const app = createApp(db, { ...env, vpnSshEnabled: true });
    const res = await app.request("/api/profiles/1/ssh", {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("GET /api/profiles/1/ssh with session when VPN_SSH_ENABLED false returns 403", async () => {
    await insertVpnProfileId1ForSsh(db);
    const app = createApp(db, { ...env, vpnSshEnabled: false });
    const res = await app.request("/api/profiles/1/ssh", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/profiles/abc/ssh with invalid id returns 400", async () => {
    const app = createApp(db, { ...env, vpnSshEnabled: true });
    const res = await app.request("/api/profiles/abc/ssh", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/profiles/99/ssh with missing profile returns 404", async () => {
    const app = createApp(db, { ...env, vpnSshEnabled: true });
    const res = await app.request("/api/profiles/99/ssh", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    });
    expect(res.status).toBe(404);
  });
});
