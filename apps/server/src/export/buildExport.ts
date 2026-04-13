import type { Database } from "bun:sqlite";

export type ExportV1 = {
  schemaVersion: 1;
  exportedAt: string;
  name?: string;
  chainId: number;
  routingProfileId: number;
  chain: Array<{
    profileId: number;
    host: string;
    sshPort: number;
    sshUser: string;
  }>;
  routing: {
    defaultAction: "use_chain" | "direct";
    rules: Array<{
      matchKind: "domain" | "cidr";
      matchValue: string;
      action: "direct" | "use_chain" | "block";
    }>;
  };
};

type ChainRow = {
  chain_id: number;
  chain_name: string;
  profile_id: number | null;
  host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
};

type RoutingProfileRow = {
  routing_profile_id: number;
  default_action: "use_chain" | "direct";
};

type RuleRow = {
  match_kind: "domain" | "cidr";
  match_value: string;
  action: "direct" | "use_chain" | "block";
};

export class ExportNotFoundError extends Error {}

export function buildExportV1(db: Database, chainId: number): ExportV1 {
  const chainRows = db
    .query<ChainRow, [number]>(
      `SELECT
        c.id AS chain_id,
        c.name AS chain_name,
        vp.id AS profile_id,
        vp.host AS host,
        vp.ssh_port AS ssh_port,
        vp.ssh_user AS ssh_user
      FROM chains c
      LEFT JOIN chain_hops ch ON ch.chain_id = c.id
      LEFT JOIN vpn_profiles vp ON vp.id = ch.vpn_profile_id
      WHERE c.id = ?
      ORDER BY ch.position ASC, ch.id ASC`,
    )
    .all(chainId);

  if (chainRows.length === 0) {
    throw new ExportNotFoundError("Chain not found");
  }

  const routingProfile = db
    .query<RoutingProfileRow, [number]>(
      `SELECT
        id AS routing_profile_id,
        default_action
      FROM routing_profiles
      WHERE chain_id = ?`,
    )
    .get(chainId);

  if (!routingProfile) {
    throw new ExportNotFoundError("Routing profile not found");
  }

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
    .all(routingProfile.routing_profile_id);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    name: chainRows[0].chain_name,
    chainId: chainRows[0].chain_id,
    routingProfileId: routingProfile.routing_profile_id,
    chain: chainRows.flatMap((row) => {
      if (
        row.profile_id === null ||
        row.host === null ||
        row.ssh_port === null ||
        row.ssh_user === null
      ) {
        return [];
      }

      return [
        {
          profileId: row.profile_id,
          host: row.host,
          sshPort: row.ssh_port,
          sshUser: row.ssh_user,
        },
      ];
    }),
    routing: {
      defaultAction: routingProfile.default_action,
      rules: ruleRows.map((row) => ({
        matchKind: row.match_kind,
        matchValue: row.match_value,
        action: row.action,
      })),
    },
  };
}
