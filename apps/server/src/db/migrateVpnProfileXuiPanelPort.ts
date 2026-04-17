import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfileXuiPanelPortIfNeeded(db: Database): void {
  const cols = vpnProfilesColumns(db);
  if (!cols.has("xui_panel_port")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_panel_port INTEGER;`);
  }
}
