import { decodeMasterKey } from "./crypto/masterKey";

export type Env = {
  port: number;
  databasePath: string;
  masterKey: Uint8Array;
  staticDir?: string;
};

export function loadEnv(): Env {
  const master = process.env.VPN_MANAGER_MASTER_KEY;
  if (!master) throw new Error("VPN_MANAGER_MASTER_KEY is required");
  const port = Number(process.env.PORT ?? "3000");
  const databasePath = process.env.DATABASE_PATH ?? "data/vpn-manager.sqlite";
  const staticDir = process.env.STATIC_DIR;
  return {
    port,
    databasePath,
    masterKey: decodeMasterKey(master),
    staticDir,
  };
}
