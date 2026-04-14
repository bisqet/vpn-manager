import { decodeMasterKey } from "./crypto/masterKey";

export type Env = {
  port: number;
  databasePath: string;
  masterKey: Uint8Array;
  staticDir?: string;
  /** When false, setup never opens outbound SSH (dry-run only). */
  vpnSshEnabled: boolean;
  /** Global ACME contact for Caddy; required when `vpnSshEnabled` is true and running live setup. */
  acmeEmail: string | undefined;
  /** Optional path to a known_hosts file for SSH (v1 may still use accept-new when unset). */
  sshKnownHostsFile: string | undefined;
};

export function loadEnv(): Env {
  const master = process.env.VPN_MANAGER_MASTER_KEY;
  if (!master) throw new Error("VPN_MANAGER_MASTER_KEY is required");
  const port = Number(process.env.PORT ?? "3000");
  const databasePath = process.env.DATABASE_PATH ?? "data/vpn-manager.sqlite";
  const staticDir = process.env.STATIC_DIR;
  const vpnSshEnabled =
    process.env.VPN_SSH_ENABLED === "1" ||
    process.env.VPN_SSH_ENABLED === "true" ||
    process.env.VPN_SSH_ENABLED === "yes";
  const acmeEmail = process.env.ACME_EMAIL?.trim() || undefined;
  const sshKnownHostsFile = process.env.SSH_KNOWN_HOSTS_FILE?.trim() || undefined;
  return {
    port,
    databasePath,
    masterKey: decodeMasterKey(master),
    staticDir,
    vpnSshEnabled,
    acmeEmail,
    sshKnownHostsFile,
  };
}
