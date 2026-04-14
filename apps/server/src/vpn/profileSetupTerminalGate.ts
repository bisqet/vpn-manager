import type { Database } from "bun:sqlite";
import { decryptVpnPassword } from "../crypto/vpnSecret";

export type ProfileSetupTerminalRow = {
  id: number;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  panel_hostname: string;
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
};

export type ResolveProfileSetupTerminalArgs = {
  db: Database;
  masterKey: Uint8Array;
  vpnSshEnabled: boolean;
  userId: number | null;
  profileId: number;
};

export type ResolveProfileSetupTerminalResult =
  | { ok: true; row: ProfileSetupTerminalRow; sshPassword: string }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 };

export async function resolveProfileSetupTerminal(
  args: ResolveProfileSetupTerminalArgs,
): Promise<ResolveProfileSetupTerminalResult> {
  if (args.userId === null) {
    return { ok: false, status: 401 };
  }
  if (!args.vpnSshEnabled) {
    return { ok: false, status: 403 };
  }
  if (!Number.isInteger(args.profileId) || args.profileId < 1) {
    return { ok: false, status: 400 };
  }

  const row =
    args.db
      .query<ProfileSetupTerminalRow, [number]>(
        `SELECT id, host, ssh_port, ssh_user, operational_status, panel_hostname,
                ssh_password_ciphertext, ssh_password_nonce
         FROM vpn_profiles WHERE id = ?`,
      )
      .get(args.profileId) ?? null;

  if (!row) {
    return { ok: false, status: 404 };
  }

  if (row.operational_status !== "pending") {
    return { ok: false, status: 409 };
  }

  if (!row.panel_hostname || row.panel_hostname.trim() === "") {
    return { ok: false, status: 400 };
  }

  const sshPassword = await decryptVpnPassword(
    args.masterKey,
    row.ssh_password_ciphertext,
    row.ssh_password_nonce,
  );

  return { ok: true, row, sshPassword };
}
