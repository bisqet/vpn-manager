import type { Database } from "bun:sqlite";

export type ExportV2 = {
  schemaVersion: 2;
  exportedAt: string;
  name?: string;
  chainId: number;
  chain: Array<{
    chainHopId: number;
    profileId: number;
    host: string;
    sshPort: number;
    sshUser: string;
  }>;
  routingByHop: Array<{
    hopIndex: number;
    chainHopId: number;
    routingProfileId: number;
    defaultAction: "use_chain" | "direct";
    rules: Array<{
      matchKind: "domain" | "cidr";
      matchValue: string;
      action: "direct" | "use_chain" | "block";
    }>;
  }>;
};

type HopRow = {
  chain_hop_id: number;
  position: number;
  vpn_profile_id: number;
  host: string;
  ssh_port: number;
  ssh_user: string;
  routing_profile_id: number | null;
  default_action: "use_chain" | "direct" | null;
};

type RuleRow = {
  match_kind: "domain" | "cidr";
  match_value: string;
  action: "direct" | "use_chain" | "block";
};

export class ExportNotFoundError extends Error {}

export function buildExportV2(db: Database, chainId: number): ExportV2 {
  const meta = db.query<{ chain_id: number; chain_name: string }, [number]>(
    "SELECT id AS chain_id, name AS chain_name FROM chains WHERE id = ?",
  ).get(chainId);

  if (!meta) {
    throw new ExportNotFoundError("Chain not found");
  }

  const hopRows = db
    .query<HopRow, [number]>(
      `SELECT
        ch.id AS chain_hop_id,
        ch.position AS position,
        ch.vpn_profile_id AS vpn_profile_id,
        vp.host AS host,
        vp.ssh_port AS ssh_port,
        vp.ssh_user AS ssh_user,
        rp.id AS routing_profile_id,
        rp.default_action AS default_action
      FROM chain_hops ch
      JOIN vpn_profiles vp ON vp.id = ch.vpn_profile_id
      LEFT JOIN routing_profiles rp ON rp.chain_hop_id = ch.id
      WHERE ch.chain_id = ?
      ORDER BY ch.position ASC, ch.id ASC`,
    )
    .all(chainId);

  const chain: ExportV2["chain"] = [];
  const routingByHop: ExportV2["routingByHop"] = [];

  for (let i = 0; i < hopRows.length; i++) {
    const row = hopRows[i]!;
    if (row.routing_profile_id === null || row.default_action === null) {
      throw new ExportNotFoundError("Routing profile not found");
    }

    chain.push({
      chainHopId: row.chain_hop_id,
      profileId: row.vpn_profile_id,
      host: row.host,
      sshPort: row.ssh_port,
      sshUser: row.ssh_user,
    });

    const ruleRows = db
      .query<RuleRow, [number]>(
        `SELECT
          match_kind,
          match_value,
          action
        FROM rules
        WHERE routing_profile_id = ?
        ORDER BY position ASC, id ASC`,
      )
      .all(row.routing_profile_id);

    routingByHop.push({
      hopIndex: i,
      chainHopId: row.chain_hop_id,
      routingProfileId: row.routing_profile_id,
      defaultAction: row.default_action,
      rules: ruleRows.map((r) => ({
        matchKind: r.match_kind,
        matchValue: r.match_value,
        action: r.action,
      })),
    });
  }

  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    name: meta.chain_name,
    chainId: meta.chain_id,
    chain,
    routingByHop,
  };
}
