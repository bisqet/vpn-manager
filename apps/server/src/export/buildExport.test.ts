import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { buildExportV1 } from "./buildExport";

describe("buildExportV1", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
  });

  test("builds a v1 export with ordered hops and no password fields", () => {
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

    const routingProfileId = Number(
      db
        .query("INSERT INTO routing_profiles (name, chain_id, default_action) VALUES (?, ?, ?)")
        .run("Primary chain routing", chainId, "use_chain").lastInsertRowid,
    );
    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(routingProfileId, 0, "domain", ".example.com", "block");
    db.query(
      "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
    ).run(routingProfileId, 1, "cidr", "10.0.0.0/8", "direct");

    const exportJson = buildExportV1(db, chainId);

    expect(exportJson.schemaVersion).toBe(1);
    expect(exportJson.chain.map((hop) => hop.profileId)).toEqual([betaProfile, alphaProfile]);
    expect(exportJson).toMatchObject({
      name: "Primary chain",
      chainId,
      routingProfileId,
      chain: [
        {
          profileId: betaProfile,
          host: "beta.example.com",
          sshPort: 2202,
          sshUser: "bob",
        },
        {
          profileId: alphaProfile,
          host: "alpha.example.com",
          sshPort: 2201,
          sshUser: "alice",
        },
      ],
      routing: {
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
    });
    expect(JSON.stringify(exportJson)).not.toContain("password");
  });
});
