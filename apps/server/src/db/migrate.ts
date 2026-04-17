import type { Database } from "bun:sqlite";
import { migratePerHopRoutingIfNeeded } from "./migratePerHopRouting";
import { migrateRoutingDefaultActionsIfNeeded } from "./migrateRoutingDefaultActions";
import { migrateVpnProfile3xUiIfNeeded } from "./migrateVpnProfile3xUi";
import { migrateVpnProfileXuiPanelPortIfNeeded } from "./migrateVpnProfileXuiPanelPort";
import { migrateVpnProfilePanelReachabilityIfNeeded } from "./migrateVpnProfilePanelReachability";
import { migrateVpnProfileOperationalStatusIfNeeded } from "./migrateVpnProfileOperationalStatus";
import schema from "./schema.sql" with { type: "text" };

export function migrate(db: Database): void {
  db.exec(schema);
  migratePerHopRoutingIfNeeded(db);
  migrateRoutingDefaultActionsIfNeeded(db);
  migrateVpnProfileOperationalStatusIfNeeded(db);
  migrateVpnProfile3xUiIfNeeded(db);
  migrateVpnProfileXuiPanelPortIfNeeded(db);
  migrateVpnProfilePanelReachabilityIfNeeded(db);
}
