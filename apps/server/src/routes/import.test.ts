import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import type { Env } from "../env";
import { createApp } from "../index";
import { migrate } from "../db/migrate";

const env: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
};

const SESSION_TOKEN = "import-session-token";
const AUTH_COOKIE = `${SESSION_COOKIE}=${SESSION_TOKEN}`;

function makeMinimalV3WithSingleHopChain() {
  return {
    schemaVersion: 3,
    chains: [
      {
        schemaVersion: 2,
        exportedAt: "2024-01-01T00:00:00.000Z",
        chainId: 42,
        name: "Test chain",
        chain: [
          {
            chainHopId: 1,
            profileId: 1,
            host: "vpn.example.com",
            sshPort: 22,
            sshUser: "root",
          },
        ],
        routingByHop: [
          {
            hopIndex: 0,
            chainHopId: 1,
            routingProfileId: 1,
            defaultAction: "direct",
            rules: [],
          },
        ],
      },
    ],
  };
}

describe("importRoutes", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    db.query("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", "hash");
    db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
      SESSION_TOKEN,
      1,
      Date.now() + 60_000,
    );
  });

  test("POST /api/import/preview with minimal valid v3 JSON returns 200 and canApply true", async () => {
    const app = createApp(db, env);
    const importDoc = makeMinimalV3WithSingleHopChain();

    const res = await app.request("/api/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Cookie: AUTH_COOKIE,
      },
      body: JSON.stringify(importDoc),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canApply).toBe(true);
    // DB is empty, so the hop needs a new profile => keys are required
    expect(body.passwordKeys).toEqual(["newProfile:0:0"]);
    expect(body.panelHostnameKeys).toEqual(["newProfile:0:0"]);
    expect(body.errors).toEqual([]);
  });

  test("POST /api/import/preview with invalid JSON returns 400", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Cookie: AUTH_COOKIE,
      },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid import JSON");
  });

  test("POST /api/import/apply with passwords and panelHostnames returns 200 and chain appears in GET /api/chains", async () => {
    const app = createApp(db, env);
    const importDoc = makeMinimalV3WithSingleHopChain();

    const applyRes = await app.request("/api/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: AUTH_COOKIE,
      },
      body: JSON.stringify({
        import: importDoc,
        passwords: { "newProfile:0:0": "secretpassword" },
        panelHostnames: { "newProfile:0:0": "panel.vpn.example.com" },
      }),
    });

    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.chainIds).toHaveLength(1);
    expect(applyBody.profileIds).toHaveLength(1);

    const listRes = await app.request("/api/chains", {
      headers: {
        Cookie: AUTH_COOKIE,
      },
    });

    expect(listRes.status).toBe(200);
    const chains = await listRes.json();
    expect(chains).toHaveLength(1);
    expect(chains[0].name).toBe("Test chain");
  });

  test("POST /api/import/apply with missing panelHostnames returns 400 and no chains created", async () => {
    const app = createApp(db, env);
    const importDoc = makeMinimalV3WithSingleHopChain();

    const applyRes = await app.request("/api/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: AUTH_COOKIE,
      },
      body: JSON.stringify({
        import: importDoc,
        passwords: { "newProfile:0:0": "secretpassword" },
        // panelHostnames omitted
      }),
    });

    expect(applyRes.status).toBe(400);
    const body = await applyRes.json();
    expect(body.error).toContain("panelHostname");

    const listRes = await app.request("/api/chains", {
      headers: {
        Cookie: AUTH_COOKIE,
      },
    });

    expect(listRes.status).toBe(200);
    const chains = await listRes.json();
    expect(chains).toHaveLength(0);
  });
});
