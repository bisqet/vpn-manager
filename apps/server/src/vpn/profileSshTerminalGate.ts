import type { Database } from "bun:sqlite";
import { decryptVpnPassword } from "../crypto/vpnSecret";

export type ProfileSshRow = {
  id: number;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
};

export type ResolveProfileSshTerminalArgs = {
  db: Database;
  masterKey: Uint8Array;
  vpnSshEnabled: boolean;
  userId: number | null;
  profileId: number;
};

export type ResolveProfileSshTerminalResult =
  | { ok: true; row: ProfileSshRow; sshPassword: string }
  | { ok: false; status: 400 | 401 | 403 | 404 };

export async function resolveProfileSshTerminal(
  args: ResolveProfileSshTerminalArgs,
): Promise<ResolveProfileSshTerminalResult> {
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
      .query<ProfileSshRow, [number]>(
        `SELECT id, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce
         FROM vpn_profiles WHERE id = ?`,
      )
      .get(args.profileId) ?? null;

  if (!row) {
    return { ok: false, status: 404 };
  }

  const sshPassword = await decryptVpnPassword(
    args.masterKey,
    row.ssh_password_ciphertext,
    row.ssh_password_nonce,
  );

  return { ok: true, row, sshPassword };
}
