import type { Database } from "bun:sqlite";
import { parseProcessAppSettingsSeed } from "../env";

export type AppSettingsDto = {
  acmeEmail: string;
  vpnSshEnabled: boolean;
  sshKnownHostsFile: string | null;
  updatedAt: string;
};

type AppSettingsRow = {
  acme_email: string;
  vpn_ssh_enabled: number;
  ssh_known_hosts_file: string | null;
  updated_at: string;
};

function rowToDto(row: AppSettingsRow): AppSettingsDto {
  return {
    acmeEmail: row.acme_email,
    vpnSshEnabled: row.vpn_ssh_enabled === 1,
    sshKnownHostsFile: row.ssh_known_hosts_file,
    updatedAt: row.updated_at,
  };
}

function bootstrapFromEnv(db: Database): void {
  const seed = parseProcessAppSettingsSeed();
  const acme = seed.acmeEmail ?? "";
  const kh = seed.sshKnownHostsFile ?? null;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO app_settings (id, acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
    [acme, seed.vpnSshEnabled ? 1 : 0, kh, now],
  );
}

/** Ensures row id=1 exists (bootstrap from process.env if missing), then returns it. */
export function getAppSettings(db: Database): AppSettingsDto {
  const row = db
    .query<AppSettingsRow, []>(
      `SELECT acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at FROM app_settings WHERE id = 1`,
    )
    .get();
  if (!row) {
    bootstrapFromEnv(db);
    return getAppSettings(db);
  }
  return rowToDto(row);
}

export function putTestAppSettings(
  db: Database,
  row: { acmeEmail: string; vpnSshEnabled: boolean; sshKnownHostsFile: string | null },
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO app_settings (id, acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       acme_email = excluded.acme_email,
       vpn_ssh_enabled = excluded.vpn_ssh_enabled,
       ssh_known_hosts_file = excluded.ssh_known_hosts_file,
       updated_at = excluded.updated_at`,
    [row.acmeEmail, row.vpnSshEnabled ? 1 : 0, row.sshKnownHostsFile, now],
  );
}

export type AppSettingsPatch = {
  acmeEmail?: string;
  vpnSshEnabled?: boolean;
  sshKnownHostsFile?: string | null;
};

export function patchAppSettings(db: Database, patch: AppSettingsPatch): AppSettingsDto {
  const current = getAppSettings(db);
  const next = {
    acmeEmail: patch.acmeEmail !== undefined ? patch.acmeEmail.trim() : current.acmeEmail,
    vpnSshEnabled: patch.vpnSshEnabled !== undefined ? patch.vpnSshEnabled : current.vpnSshEnabled,
    sshKnownHostsFile:
      patch.sshKnownHostsFile !== undefined
        ? patch.sshKnownHostsFile === null || patch.sshKnownHostsFile.trim() === ""
          ? null
          : patch.sshKnownHostsFile.trim()
        : current.sshKnownHostsFile,
  };
  if (next.vpnSshEnabled && next.acmeEmail === "") {
    const err = new Error("acme_email_required_when_ssh_enabled");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  db.run(
    `UPDATE app_settings SET acme_email = ?, vpn_ssh_enabled = ?, ssh_known_hosts_file = ?, updated_at = ? WHERE id = 1`,
    [next.acmeEmail, next.vpnSshEnabled ? 1 : 0, next.sshKnownHostsFile, now],
  );
  return getAppSettings(db);
}
