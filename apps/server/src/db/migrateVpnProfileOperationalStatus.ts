import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfileOperationalStatusIfNeeded(db: Database): void {
  if (vpnProfilesColumns(db).has("operational_status")) {
    return;
  }

  db.exec(
    `ALTER TABLE vpn_profiles ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'pending'
     CHECK (operational_status IN ('pending','working'));`,
  );
  db.exec(`UPDATE vpn_profiles SET operational_status = 'pending' WHERE operational_status IS NULL`);
}
