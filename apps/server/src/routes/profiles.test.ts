import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import { decryptVpnPassword, encryptVpnPassword } from "../crypto/vpnSecret";
import { putTestAppSettings } from "../db/appSettings";
import { migrate } from "../db/migrate";
import type { Env } from "../env";
import { createApp } from "../index";
import { buildPanelHttpsUrl } from "../net/panelAddress";
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
    putTestAppSettings(db, {
      acmeEmail: "",
      vpnSshEnabled: false,
      sshKnownHostsFile: null,
    });
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
      lastSetupError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      panelUrl: null,
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
      lastSetupError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      panelUrl: null,
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
      lastSetupError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      panelUrl: null,
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

  test("force-deletes profile, removes hops, renumbers remaining hops on multi-hop chain", async () => {
    const app = createApp(db, env);

    for (const body of [
      { label: "A", host: "a.example.com", sshPort: 22, sshUser: "u", sshPassword: "p", panelHostname: "panel.a.example.com" },
      { label: "B", host: "b.example.com", sshPort: 22, sshUser: "u", sshPassword: "p", panelHostname: "panel.b.example.com" },
    ]) {
      const res = await app.request("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=session-token` },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
    }

    db.query("INSERT INTO chains (name) VALUES (?)").run("Multi");
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 0, 1);
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 1, 2);

    const forceRes = await app.request("/api/profiles/1?force=true", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(forceRes.status).toBe(200);
    expect(await forceRes.json()).toEqual({ ok: true });

    expect(db.query("SELECT id FROM vpn_profiles WHERE id = ?").get(1)).toBeNull();

    const hops = db
      .query<{ chain_id: number; position: number; vpn_profile_id: number }, []>(
        "SELECT chain_id, position, vpn_profile_id FROM chain_hops ORDER BY chain_id, position",
      )
      .all();
    expect(hops).toEqual([{ chain_id: 1, position: 0, vpn_profile_id: 2 }]);

    expect(db.query("SELECT id FROM chains WHERE id = ?").get(1)).not.toBeNull();
  });

  test("force-deletes profile and removes chain when it was the only hop", async () => {
    const app = createApp(db, env);

    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=session-token` },
      body: JSON.stringify({
        label: "Solo",
        host: "solo.example.com",
        sshPort: 22,
        sshUser: "u",
        sshPassword: "p",
        panelHostname: "panel.solo.example.com",
      }),
    });
    expect(createRes.status).toBe(201);

    db.query("INSERT INTO chains (name) VALUES (?)").run("Only");
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 0, 1);

    const forceRes = await app.request("/api/profiles/1?force=true", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(forceRes.status).toBe(200);
    expect(await forceRes.json()).toEqual({ ok: true });

    expect(db.query("SELECT id FROM vpn_profiles WHERE id = ?").get(1)).toBeNull();
    expect(db.query("SELECT id FROM chain_hops WHERE chain_id = ?").all(1)).toEqual([]);
    expect(db.query("SELECT id FROM chains WHERE id = ?").get(1)).toBeNull();
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

  test("POST /api/profiles/:id/setup live path succeeds with fake ssh when ACME email empty", async () => {
    putTestAppSettings(db, {
      acmeEmail: "",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "NoAcme",
        host: "10.0.0.2",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "secretpw",
        panelHostname: "panel.noacme.example.com",
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
  });

  test("POST /api/profiles/:id/setup live path succeeds with fake ssh", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

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

  test("GET /api/profiles returns panelUrl null without session when profile working", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

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

    const listRes = await app.request("/api/profiles");
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { panelUrl: string | null }[];
    expect(listed[0]!.panelUrl).toBeNull();
  });

  test("GET /api/profiles/:id/panel-login returns 401 without session", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/profiles/1/panel-login");
    expect(res.status).toBe(401);
  });

  test("GET /api/profiles/:id/panel-login returns 200 with credentials after live setup", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

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

    const dbRow = db
      .query<{ panel_hostname: string; xui_web_base_path: string | null }, []>(
        "SELECT panel_hostname, xui_web_base_path FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(dbRow).toBeDefined();

    const loginRes = await app.request("/api/profiles/1/panel-login", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as {
      adminUsername: string;
      adminPassword: string;
      panelUrl: string;
    };
    expect(body.adminUsername.length).toBeGreaterThan(0);
    expect(body.adminPassword.length).toBeGreaterThan(0);
    expect(body.panelUrl.length).toBeGreaterThan(0);
    expect(body.panelUrl).toBe(buildPanelHttpsUrl(dbRow!.panel_hostname, dbRow!.xui_web_base_path));
  });

  test("GET /api/profiles/:id/panel-login returns 404 when profile missing", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/profiles/99/panel-login", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Profile not found" });
  });

  test("GET /api/profiles/:id/panel-login returns 409 when profile is pending", async () => {
    const app = createApp(db, env);
    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Pending",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.pending.example.com",
      }),
    });
    expect(createRes.status).toBe(201);

    const loginRes = await app.request("/api/profiles/1/panel-login", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(loginRes.status).toBe(409);
    expect(await loginRes.json()).toEqual({
      error: "Panel login is only available after successful setup",
    });
  });

  test("GET /api/profiles returns panelUrl when session and working", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

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

    const dbRow = db
      .query<{ panel_hostname: string; xui_web_base_path: string | null }, []>(
        "SELECT panel_hostname, xui_web_base_path FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(dbRow).toBeDefined();

    const listRes = await app.request("/api/profiles", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { panelUrl: string | null }[];
    expect(listed[0]!.panelUrl).toBe(
      buildPanelHttpsUrl(dbRow!.panel_hostname, dbRow!.xui_web_base_path),
    );
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
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const app = createApp(db, env);
    const res = await app.request("/api/profiles/1/ssh", {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("GET /api/profiles/1/ssh with session when VPN_SSH_ENABLED false returns 403", async () => {
    await insertVpnProfileId1ForSsh(db);
    putTestAppSettings(db, {
      acmeEmail: "",
      vpnSshEnabled: false,
      sshKnownHostsFile: null,
    });
    const app = createApp(db, env);
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
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const app = createApp(db, env);
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
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const app = createApp(db, env);
    const res = await app.request("/api/profiles/99/ssh", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    });
    expect(res.status).toBe(404);
  });

  test("GET /api/profiles/ssh-terminal/preflight returns sshTerminalEnabled", async () => {
    putTestAppSettings(db, {
      acmeEmail: "",
      vpnSshEnabled: false,
      sshKnownHostsFile: null,
    });
    const app = createApp(db, env);
    const authed = await app.request("/api/profiles/ssh-terminal/preflight", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(authed.status).toBe(200);
    const body = await authed.json();
    expect(body.sshTerminalEnabled).toBe(false);

    const anon = await app.request("/api/profiles/ssh-terminal/preflight");
    expect(anon.status).toBe(401);
  });

  test("POST /api/profiles/:id/clear-server dry-run leaves DB unchanged", async () => {
    const app = createApp(db, env);
    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "ClearDry",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.clear-dry.example.com",
      }),
    });
    expect(createRes.status).toBe(201);

    db.query(
      "UPDATE vpn_profiles SET operational_status = 'working', xui_web_base_path = ? WHERE id = 1",
    ).run("abc");

    const clearRes = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as {
      teardown: { mode: string; phases: { id: string }[] };
    };
    expect(body.teardown.mode).toBe("dry-run");
    expect(body.teardown.phases[0]?.id).toBe("stop_xui");

    const row = db
      .query<{ operational_status: string; xui_web_base_path: string | null }, []>(
        "SELECT operational_status, xui_web_base_path FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(row?.operational_status).toBe("working");
    expect(row?.xui_web_base_path).toBe("abc");
  });

  test("POST /api/profiles/:id/clear-server returns 400 when not eligible (pending, no setup failure)", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "PendingOnly",
        host: "10.0.0.2",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "secretpw",
        panelHostname: "panel.pending-only.example.com",
      }),
    });

    const clearRes = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(clearRes.status).toBe(400);
  });

  test("POST /api/profiles/:id/clear-server live success clears DB fields", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "LiveClear",
        host: "10.0.0.3",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "secretpw",
        panelHostname: "panel.live-clear.example.com",
      }),
    });

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(200);

    const clearRes = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as {
      profile: { operationalStatus: string };
      teardown: { mode: string };
    };
    expect(body.teardown.mode).toBe("live");
    expect(body.profile.operationalStatus).toBe("pending");

    const row = db
      .query<{ operational_status: string; xui_web_base_path: string | null; last_setup_error: string | null }, []>(
        "SELECT operational_status, xui_web_base_path, last_setup_error FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(row?.operational_status).toBe("pending");
    expect(row?.xui_web_base_path).toBeNull();
    expect(row?.last_setup_error).toBeNull();
  });

  test("POST /api/profiles/:id/clear-server live failure returns 500 and keeps working", async () => {
    putTestAppSettings(db, {
      acmeEmail: "ops@example.com",
      vpnSshEnabled: true,
      sshKnownHostsFile: null,
    });
    let teardownPhase: "setup" | "clear" = "setup";
    let clearCallIndex = 0;
    const fakeSsh: SshExecFn = async () => {
      if (teardownPhase === "setup") {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      clearCallIndex += 1;
      if (clearCallIndex === 1) {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "boom" };
    };
    const app = createApp(db, env, { profiles: { sshExec: fakeSsh } });

    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "LiveClearFail",
        host: "10.0.0.4",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "secretpw",
        panelHostname: "panel.live-clear-fail.example.com",
      }),
    });

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(200);

    teardownPhase = "clear";
    clearCallIndex = 0;

    const clearRes = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(clearRes.status).toBe(500);

    const row = db.query<{ operational_status: string }, []>(
      "SELECT operational_status FROM vpn_profiles WHERE id = 1",
    ).get();
    expect(row?.operational_status).toBe("working");
  });
});
