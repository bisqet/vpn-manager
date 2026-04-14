import type { Database } from "bun:sqlite";

function routingProfileNameForHop(chainName: string, position: number): string {
  return `${chainName} hop ${position}`;
}

function insertRoutingProfilesForHops(
  db: Database,
  chainId: number,
  chainName: string,
  hopCount: number,
): void {
  for (let position = 0; position < hopCount; position++) {
    const hopRow = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM chain_hops WHERE chain_id = ? AND position = ?",
      )
      .get(chainId, position);
    if (!hopRow) {
      throw new Error("Expected chain_hops row after insert");
    }
    const isTerminalHop = position === hopCount - 1;
    const defaultAction = isTerminalHop ? "direct" : "use_chain";
    db.query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)").run(
      routingProfileNameForHop(chainName, position),
      hopRow.id,
      defaultAction,
    );
  }
}

export function insertChainWithHops(
  db: Database,
  { name, vpnProfileIds }: { name: string; vpnProfileIds: number[] },
): number {
  const chainResult = db.query("INSERT INTO chains (name) VALUES (?)").run(name);
  const chainId = Number(chainResult.lastInsertRowid);

  for (const [position, vpnProfileId] of vpnProfileIds.entries()) {
    db.query(
      "INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)",
    ).run(chainId, position, vpnProfileId);
  }

  insertRoutingProfilesForHops(db, chainId, name, vpnProfileIds.length);

  return chainId;
}
