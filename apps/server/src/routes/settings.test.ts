import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import { putTestAppSettings } from "../db/appSettings";
import { migrate } from "../db/migrate";
import type { Env } from "../env";
import { createApp } from "../index";

const baseEnv: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
};

describe("settingsRoutes", () => {
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
      acmeEmail: "a@b.co",
      vpnSshEnabled: false,
      sshKnownHostsFile: null,
    });
  });

  test("GET /api/settings 401 without cookie", async () => {
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings");
    expect(res.status).toBe(401);
  });

  test("GET /api/settings 200 with session", async () => {
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acmeEmail: string; vpnSshEnabled: boolean };
    expect(body.acmeEmail).toBe("a@b.co");
    expect(body.vpnSshEnabled).toBe(false);
  });

  test("PATCH allows live SSH with empty ACME email", async () => {
    putTestAppSettings(db, { acmeEmail: "", vpnSshEnabled: false, sshKnownHostsFile: null });
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vpnSshEnabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acmeEmail: string; vpnSshEnabled: boolean };
    expect(body.vpnSshEnabled).toBe(true);
    expect(body.acmeEmail).toBe("");
  });
});
