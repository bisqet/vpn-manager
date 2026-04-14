import type { Database } from "bun:sqlite";
import { migratePerHopRoutingIfNeeded } from "./migratePerHopRouting";
import { migrateRoutingDefaultActionsIfNeeded } from "./migrateRoutingDefaultActions";
import { migrateVpnProfileOperationalStatusIfNeeded } from "./migrateVpnProfileOperationalStatus";
import schema from "./schema.sql" with { type: "text" };

export function migrate(db: Database): void {
  db.exec(schema);
  migratePerHopRoutingIfNeeded(db);
  migrateRoutingDefaultActionsIfNeeded(db);
  migrateVpnProfileOperationalStatusIfNeeded(db);
}
