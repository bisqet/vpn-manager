import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfilePanelReachabilityIfNeeded(db: Database): void {
  const cols = vpnProfilesColumns(db);
  if (!cols.has("panel_reachability")) {
    db.exec(`
      ALTER TABLE vpn_profiles ADD COLUMN panel_reachability TEXT NOT NULL DEFAULT 'unknown'
        CHECK(panel_reachability IN ('unknown','checking','reachable','unreachable'));
    `);
  }
  if (!cols.has("panel_reachability_detail")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_reachability_detail TEXT;`);
  }
  if (!cols.has("panel_reachability_checked_at")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_reachability_checked_at TEXT;`);
  }
}
