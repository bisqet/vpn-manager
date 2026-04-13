import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { buildExportV2 } from "./buildExport";

describe("buildExportV2", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
  });

  test("builds a v2 export with routingByHop per hop and no password fields", () => {
    const alphaProfile = Number(
      db
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
        .run("Alpha", "alpha.example.com", 2201, "alice", new Uint8Array([1, 2, 3]), new Uint8Array([4]))
        .lastInsertRowid,
    );
    const betaProfile = Number(
      db
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
        .run("Beta", "beta.example.com", 2202, "bob", new Uint8Array([5, 6, 7]), new Uint8Array([8]))
        .lastInsertRowid,
    );
    const chainId = Number(db.query("INSERT INTO chains (name) VALUES (?)").run("Primary chain").lastInsertRowid);
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(
      chainId,
      0,
      betaProfile,
    );
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(
      chainId,
      1,
      alphaProfile,
    );

    const hop0Id = Number(
      db
        .query<{ id: number }, [number]>("SELECT id FROM chain_hops WHERE chain_id = ? AND position = 0")
        .get(chainId)!.id,
    );
    const hop1Id = Number(
      db
        .query<{ id: number }, [number]>("SELECT id FROM chain_hops WHERE chain_id = ? AND position = 1")
        .get(chainId)!.id,
    );

    const routingProfile0 = Number(
      db
        .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
        .run("hop0", hop0Id, "use_chain").lastInsertRowid,
    );
    const routingProfile1 = Number(
      db
        .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
        .run("hop1", hop1Id, "direct").lastInsertRowid,
    );

    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(routingProfile0, 0, "domain", ".example.com", "block");
    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(routingProfile0, 1, "cidr", "10.0.0.0/8", "direct");
    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(routingProfile1, 0, "domain", ".corp", "use_chain");

    const exportJson = buildExportV2(db, chainId);

    expect(exportJson.schemaVersion).toBe(2);
    expect(exportJson.routingByHop).toHaveLength(2);
    expect(exportJson.chain.map((hop) => hop.profileId)).toEqual([betaProfile, alphaProfile]);
    expect(exportJson).toMatchObject({
      name: "Primary chain",
      chainId,
      chain: [
        {
          chainHopId: hop0Id,
          profileId: betaProfile,
          host: "beta.example.com",
          sshPort: 2202,
          sshUser: "bob",
        },
        {
          chainHopId: hop1Id,
          profileId: alphaProfile,
          host: "alpha.example.com",
          sshPort: 2201,
          sshUser: "alice",
        },
      ],
      routingByHop: [
        {
          hopIndex: 0,
          chainHopId: hop0Id,
          routingProfileId: routingProfile0,
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
          chainHopId: hop1Id,
          routingProfileId: routingProfile1,
          defaultAction: "direct",
          rules: [
            {
              matchKind: "domain",
              matchValue: ".corp",
              action: "use_chain",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(exportJson)).not.toContain("password");
  });
});
