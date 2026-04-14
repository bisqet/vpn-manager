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

describe("routingRoutes", () => {
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

  function authHeaders(contentType = false) {
    return {
      ...(contentType ? { "Content-Type": "application/json" } : {}),
      Cookie: `${SESSION_COOKIE}=session-token`,
    };
  }

  function seedVpnProfile() {
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
      .run("Alpha", "alpha.example.com", 22, "root", new Uint8Array([1]), new Uint8Array([2]));
    return Number(result.lastInsertRowid);
  }

  function seedChain(name = "Primary chain") {
    const result = db.query("INSERT INTO chains (name) VALUES (?)").run(name);
    return Number(result.lastInsertRowid);
  }

  function seedHop(chainId: number, position: number, vpnProfileId: number) {
    const result = db
      .query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)")
      .run(chainId, position, vpnProfileId);
    return Number(result.lastInsertRowid);
  }

  function seedRoutingProfileForHop(
    chainHopId: number,
    defaultAction: "use_chain" | "direct" | "block" = "use_chain",
  ) {
    const result = db
      .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
      .run(`hop ${chainHopId} routing`, chainHopId, defaultAction);
    return Number(result.lastInsertRowid);
  }

  function seedRule(
    routingProfileId: number,
    position: number,
    matchKind: "domain" | "cidr",
    matchValue: string,
    action: "direct" | "use_chain" | "block",
  ) {
    const result = db
      .query(
        "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
      )
      .run(routingProfileId, position, matchKind, matchValue, action);
    return Number(result.lastInsertRowid);
  }

  test("requires auth for routing routes", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/routing/by-hop/1");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("gets and patches routing profiles with ordered rules", async () => {
    const app = createApp(db, env);
    const vpnProfileId = seedVpnProfile();
    const chainId = seedChain();
    const hopId = seedHop(chainId, 0, vpnProfileId);
    const routingProfileId = seedRoutingProfileForHop(hopId);
    const firstRuleId = seedRule(routingProfileId, 0, "domain", ".example.com", "block");
    const secondRuleId = seedRule(routingProfileId, 1, "cidr", "10.0.0.0/8", "direct");

    const getRes = await app.request(`/api/routing/by-hop/${hopId}`, {
      headers: authHeaders(),
    });

    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      id: routingProfileId,
      name: `hop ${hopId} routing`,
      chainHopId: hopId,
      chainId,
      defaultAction: "use_chain",
      rules: [
        {
          id: firstRuleId,
          position: 0,
          matchKind: "domain",
          matchValue: ".example.com",
          action: "block",
        },
        {
          id: secondRuleId,
          position: 1,
          matchKind: "cidr",
          matchValue: "10.0.0.0/8",
          action: "direct",
        },
      ],
    });

    const patchRes = await app.request(`/api/routing/${routingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "direct",
        rules: [
          {
            matchKind: "domain",
            matchValue: " *.Example.COM ",
            action: "use_chain",
          },
          {
            matchKind: "cidr",
            matchValue: "192.168.0.0/16",
            action: "block",
          },
        ],
      }),
    });

    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toEqual({
      id: routingProfileId,
      name: `hop ${hopId} routing`,
      chainHopId: hopId,
      chainId,
      defaultAction: "direct",
      rules: [
        {
          id: 3,
          position: 0,
          matchKind: "domain",
          matchValue: ".example.com",
          action: "use_chain",
        },
        {
          id: 4,
          position: 1,
          matchKind: "cidr",
          matchValue: "192.168.0.0/16",
          action: "block",
        },
      ],
    });

    expect(
      db
        .query<{ default_action: string }, [number]>(
          "SELECT default_action FROM routing_profiles WHERE id = ?",
        )
        .get(routingProfileId),
    ).toEqual({ default_action: "direct" });

    expect(
      db
        .query<
          { position: number; match_kind: string; match_value: string; action: string },
          [number]
        >(
          "SELECT position, match_kind, match_value, action FROM rules WHERE routing_profile_id = ? ORDER BY position ASC",
        )
        .all(routingProfileId),
    ).toEqual([
      {
        position: 0,
        match_kind: "domain",
        match_value: ".example.com",
        action: "use_chain",
      },
      {
        position: 1,
        match_kind: "cidr",
        match_value: "192.168.0.0/16",
        action: "block",
      },
    ]);
  });

  test("rejects invalid domain rules after normalization", async () => {
    const app = createApp(db, env);
    const vpnProfileId = seedVpnProfile();
    const chainId = seedChain();
    const hopId = seedHop(chainId, 0, vpnProfileId);
    const routingProfileId = seedRoutingProfileForHop(hopId);

    const res = await app.request(`/api/routing/${routingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "direct",
        rules: [
          {
            matchKind: "domain",
            matchValue: "example.com",
            action: "block",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Domain rule must start with '.' after normalization (e.g. '.ru')",
    });
  });

  test("rejects invalid cidr rules", async () => {
    const app = createApp(db, env);
    const vpnProfileId = seedVpnProfile();
    const chainId = seedChain();
    const hopId = seedHop(chainId, 0, vpnProfileId);
    const routingProfileId = seedRoutingProfileForHop(hopId);

    const res = await app.request(`/api/routing/${routingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "direct",
        rules: [
          {
            matchKind: "cidr",
            matchValue: "not-a-cidr",
            action: "direct",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "CIDR must include a prefix length (e.g. 10.0.0.0/8 or 2001:db8::/32)",
    });
  });

  test("rejects use_chain defaultAction on terminal hop (two-hop chain)", async () => {
    const app = createApp(db, env);
    const vpnProfileId0 = seedVpnProfile();
    const vpnProfileId1 = seedVpnProfile();
    const chainId = seedChain();
    const hop0 = seedHop(chainId, 0, vpnProfileId0);
    const hop1 = seedHop(chainId, 1, vpnProfileId1);
    seedRoutingProfileForHop(hop0);
    const terminalRoutingProfileId = seedRoutingProfileForHop(hop1);

    const res = await app.request(`/api/routing/${terminalRoutingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "use_chain",
        rules: [
          {
            matchKind: "domain",
            matchValue: ".example.com",
            action: "direct",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Terminal hop cannot use defaultAction use_chain; use direct or block.",
    });
  });

  test("allows block defaultAction on terminal hop with valid rules", async () => {
    const app = createApp(db, env);
    const vpnProfileId0 = seedVpnProfile();
    const vpnProfileId1 = seedVpnProfile();
    const chainId = seedChain();
    const hop0 = seedHop(chainId, 0, vpnProfileId0);
    const hop1 = seedHop(chainId, 1, vpnProfileId1);
    seedRoutingProfileForHop(hop0);
    const terminalRoutingProfileId = seedRoutingProfileForHop(hop1);

    const res = await app.request(`/api/routing/${terminalRoutingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "block",
        rules: [
          {
            matchKind: "domain",
            matchValue: ".example.com",
            action: "direct",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultAction: string };
    expect(body.defaultAction).toBe("block");
    expect(
      db
        .query<{ default_action: string }, [number]>(
          "SELECT default_action FROM routing_profiles WHERE id = ?",
        )
        .get(terminalRoutingProfileId),
    ).toEqual({ default_action: "block" });
  });

  test("allows use_chain defaultAction on non-terminal hop", async () => {
    const app = createApp(db, env);
    const vpnProfileId0 = seedVpnProfile();
    const vpnProfileId1 = seedVpnProfile();
    const chainId = seedChain();
    const hop0 = seedHop(chainId, 0, vpnProfileId0);
    const hop1 = seedHop(chainId, 1, vpnProfileId1);
    const firstHopRoutingProfileId = seedRoutingProfileForHop(hop0);
    seedRoutingProfileForHop(hop1);

    const res = await app.request(`/api/routing/${firstHopRoutingProfileId}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        defaultAction: "use_chain",
        rules: [
          {
            matchKind: "domain",
            matchValue: ".example.com",
            action: "direct",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultAction: string };
    expect(body.defaultAction).toBe("use_chain");
  });
});
