import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfile3xUiIfNeeded(db: Database): void {
  const cols = vpnProfilesColumns(db);
  if (!cols.has("panel_hostname")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_hostname TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.has("xui_secrets_ciphertext")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_secrets_ciphertext BLOB;`);
  }
  if (!cols.has("xui_secrets_nonce")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_secrets_nonce BLOB;`);
  }
  if (!cols.has("xui_web_base_path")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_web_base_path TEXT;`);
  }
  if (!cols.has("last_setup_error")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN last_setup_error TEXT;`);
  }
  if (!cols.has("last_setup_at")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN last_setup_at TEXT;`);
  }
}
