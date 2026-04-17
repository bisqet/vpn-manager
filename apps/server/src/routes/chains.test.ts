import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import { encryptXuiSecretsJson } from "../crypto/xuiSecrets";
import { migrate } from "../db/migrate";
import type { Env } from "../env";
import { createApp } from "../index";

type RoutingProfileRow = {
  id: number;
  name: string;
  chain_hop_id: number;
  default_action: string;
};

const env: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
};

function hopsDtoForChain(db: Database, chainId: number) {
  return db
    .query<
      { id: number; position: number; vpn_profile_id: number; label: string },
      [number]
    >(
      `SELECT h.id, h.position, h.vpn_profile_id, vp.label
       FROM chain_hops h
       JOIN vpn_profiles vp ON vp.id = h.vpn_profile_id
       WHERE h.chain_id = ?
       ORDER BY h.position ASC, h.id ASC`,
    )
    .all(chainId)
    .map((h) => ({
      id: h.id,
      position: h.position,
      vpnProfileId: h.vpn_profile_id,
      label: h.label,
    }));
}

describe("chainsRoutes", () => {
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

  async function seedWorkingVpnProfile(dbConn: Database, masterKey: Uint8Array, profileId: number) {
    const { ciphertext, nonce } = await encryptXuiSecretsJson(masterKey, {
      v: 1,
      adminUsername: "admin",
      adminPassword: "secret",
    });
    dbConn.query(
      `UPDATE vpn_profiles SET
        operational_status = 'working',
        panel_hostname = 'panel.test',
        xui_secrets_ciphertext = ?,
        xui_secrets_nonce = ?,
        xui_web_base_path = ?,
        xui_panel_port = ?,
        last_setup_error = NULL
      WHERE id = ?`,
    ).run(ciphertext, nonce, "webpath12", null, profileId);
  }

  function seedVpnProfile(label: string) {
    const result = db
      .query(
        `INSERT INTO vpn_profiles (
          label,
          host,
          ssh_port,
          ssh_user,
          ssh_password_ciphertext,
          ssh_password_nonce
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(label, `${label.toLowerCase()}.example.com`, 22, "root", new Uint8Array([1]), new Uint8Array([2]));

    return Number(result.lastInsertRowid);
  }

  test("requires auth for chain routes", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/chains");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("creates, lists, updates, and deletes chains with a routing profile", async () => {
    const app = createApp(db, env);
    const firstProfileId = seedVpnProfile("Alpha");
    const secondProfileId = seedVpnProfile("Beta");
    const thirdProfileId = seedVpnProfile("Gamma");

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Primary chain",
        vpnProfileIds: [firstProfileId, secondProfileId],
      }),
    });

    expect(createRes.status).toBe(201);
    expect(await createRes.json()).toEqual({
      id: 1,
      name: "Primary chain",
      vpnProfileIds: [firstProfileId, secondProfileId],
      hops: hopsDtoForChain(db, 1),
    });

    const routingProfiles = db
      .query<RoutingProfileRow, [number]>(
        `SELECT rp.id, rp.name, rp.chain_hop_id, rp.default_action
         FROM routing_profiles rp
         JOIN chain_hops ch ON ch.id = rp.chain_hop_id
         WHERE ch.chain_id = ?
         ORDER BY ch.position ASC`,
      )
      .all(1);
    expect(routingProfiles).toEqual([
      {
        id: 1,
        name: "Primary chain hop 0",
        chain_hop_id: 1,
        default_action: "use_chain",
      },
      {
        id: 2,
        name: "Primary chain hop 1",
        chain_hop_id: 2,
        default_action: "direct",
      },
    ]);

    const listRes = await app.request("/api/chains", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([
      {
        id: 1,
        name: "Primary chain",
        vpnProfileIds: [firstProfileId, secondProfileId],
        hops: hopsDtoForChain(db, 1),
      },
    ]);

    const patchRes = await app.request("/api/chains/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Updated chain",
        vpnProfileIds: [thirdProfileId, firstProfileId],
      }),
    });

    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toEqual({
      id: 1,
      name: "Updated chain",
      vpnProfileIds: [thirdProfileId, firstProfileId],
      hops: hopsDtoForChain(db, 1),
    });

    const hops = db
      .query<{ position: number; vpn_profile_id: number }, [number]>(
        "SELECT position, vpn_profile_id FROM chain_hops WHERE chain_id = ? ORDER BY position ASC",
      )
      .all(1);
    expect(hops).toEqual([
      { position: 0, vpn_profile_id: thirdProfileId },
      { position: 1, vpn_profile_id: firstProfileId },
    ]);

    const routingAfterPatch = db
      .query<RoutingProfileRow, [number]>(
        `SELECT rp.id, rp.name, rp.chain_hop_id, rp.default_action
         FROM routing_profiles rp
         JOIN chain_hops ch ON ch.id = rp.chain_hop_id
         WHERE ch.chain_id = ?
         ORDER BY ch.position ASC`,
      )
      .all(1);
    expect(routingAfterPatch).toEqual([
      {
        id: 3,
        name: "Updated chain hop 0",
        chain_hop_id: 3,
        default_action: "use_chain",
      },
      {
        id: 4,
        name: "Updated chain hop 1",
        chain_hop_id: 4,
        default_action: "direct",
      },
    ]);

    const deleteRes = await app.request("/api/chains/1", {
      method: "DELETE",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(db.query("SELECT id FROM chains WHERE id = ?").get(1)).toBeNull();
    expect(db.query("SELECT id FROM chain_hops WHERE chain_id = ?").get(1)).toBeNull();
    expect(db.query("SELECT id FROM routing_profiles").all()).toEqual([]);
  });

  test("single-hop chain creates one routing profile with default_action direct", async () => {
    const app = createApp(db, env);
    const profileId = seedVpnProfile("Solo");

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Single hop",
        vpnProfileIds: [profileId],
      }),
    });

    expect(createRes.status).toBe(201);

    const routingProfiles = db
      .query<RoutingProfileRow, [number]>(
        `SELECT rp.id, rp.name, rp.chain_hop_id, rp.default_action
         FROM routing_profiles rp
         JOIN chain_hops ch ON ch.id = rp.chain_hop_id
         WHERE ch.chain_id = ?`,
      )
      .all(1);
    expect(routingProfiles).toEqual([
      {
        id: 1,
        name: "Single hop hop 0",
        chain_hop_id: 1,
        default_action: "direct",
      },
    ]);
  });

  test("downloads a chain export as json", async () => {
    const app = createApp(db, env);
    const firstProfileId = seedVpnProfile("Alpha");
    const secondProfileId = seedVpnProfile("Beta");

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Primary chain",
        vpnProfileIds: [firstProfileId, secondProfileId],
      }),
    });

    expect(createRes.status).toBe(201);

    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(1, 0, "domain", ".example.com", "block");
    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(1, 1, "cidr", "10.0.0.0/8", "direct");

    const hopRows = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM chain_hops WHERE chain_id = ? ORDER BY position ASC, id ASC",
      )
      .all(1);

    const exportRes = await app.request("/api/chains/1/export", {
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("Content-Type")).toContain("application/json");
    expect(exportRes.headers.get("Content-Disposition")).toBe(
      'attachment; filename="vpn-manager.routing.v2.json"',
    );
    expect(await exportRes.json()).toMatchObject({
      schemaVersion: 2,
      name: "Primary chain",
      chainId: 1,
      chain: [
        {
          chainHopId: hopRows[0]!.id,
          profileId: firstProfileId,
          host: "alpha.example.com",
          sshPort: 22,
          sshUser: "root",
        },
        {
          chainHopId: hopRows[1]!.id,
          profileId: secondProfileId,
          host: "beta.example.com",
          sshPort: 22,
          sshUser: "root",
        },
      ],
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: hopRows[0]!.id,
          routingProfileId: 1,
          defaultAction: "use_chain",
          rules: [
            {
              matchKind: "domain",
              matchValue: ".example.com",
              action: "block",
            },
            {
              matchKind: "cidr",
              matchValue: "10.0.0.0/8",
              action: "direct",
            },
          ],
        },
        {
          hopIndex: 1,
          chainHopId: hopRows[1]!.id,
          routingProfileId: 2,
          defaultAction: "direct",
          rules: [],
        },
      ],
    });
  });

  test("rejects duplicate vpnProfileIds on create", async () => {
    const app = createApp(db, env);
    const profileId = seedVpnProfile("Alpha");

    const res = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Invalid chain",
        vpnProfileIds: [profileId, profileId],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "vpnProfileIds must be unique" });
  });

  test("rejects empty vpnProfileIds on create", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Invalid chain",
        vpnProfileIds: [],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "vpnProfileIds must contain at least one profile id" });
  });

  test("generate-profile returns 400 for multi-hop chain", async () => {
    const app = createApp(db, env);
    const firstProfileId = seedVpnProfile("Alpha");
    const secondProfileId = seedVpnProfile("Beta");

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Two hops",
        vpnProfileIds: [firstProfileId, secondProfileId],
      }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("/api/chains/1/generate-profile", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Generate profile requires a single-hop chain." });
  });

  test("generate-profile returns 404 when chain is missing", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/chains/99/generate-profile", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chain not found" });
  });

  test("generate-profile returns 409 when single-hop profile is pending", async () => {
    const app = createApp(db, env);
    const profileId = seedVpnProfile("Solo");

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Single hop",
        vpnProfileIds: [profileId],
      }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("/api/chains/1/generate-profile", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "VPN profile must be working with stored panel credentials.",
    });
  });

  test("generate-profile returns 200 with share and subscription URLs when panel succeeds", async () => {
    const originalFetch = globalThis.fetch;
    const app = createApp(db, env);
    const profileId = seedVpnProfile("Solo");
    await seedWorkingVpnProfile(db, env.masterKey, profileId);

    const createRes = await app.request("/api/chains", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        name: "Single hop",
        vpnProfileIds: [profileId],
      }),
    });
    expect(createRes.status).toBe(201);

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith("/login")) {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")?.toLowerCase()).toContain("application/x-www-form-urlencoded");
        const params = new URLSearchParams(init?.body as string);
        expect(params.get("username")).toBe("admin");
        expect(params.get("password")).toBe("secret");

        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "3x-ui=abc; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/panel/api/inbounds/add")) {
        const inboundBody = JSON.parse(init?.body as string) as Record<string, string | number | boolean>;
        const settingsClients = JSON.parse(inboundBody.settings as string) as { clients: unknown[] };
        const addObj = {
          port: inboundBody.port,
          protocol: "vless",
          settings: JSON.stringify(settingsClients),
          streamSettings: inboundBody.streamSettings,
        };

        return new Response(JSON.stringify({ success: true, msg: "created", obj: addObj }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await app.request("/api/chains/1/generate-profile", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=session-token`,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { vlessShareLink: string; subscriptionUrl: string };
      expect(typeof body.vlessShareLink).toBe("string");
      expect(typeof body.subscriptionUrl).toBe("string");
      expect(body.vlessShareLink.startsWith("vless://")).toBe(true);
      expect(body.subscriptionUrl).toContain("/sub/");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
