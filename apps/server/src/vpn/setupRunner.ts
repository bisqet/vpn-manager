import type { Database } from "bun:sqlite";
import { decryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { getAppSettings } from "../db/appSettings";
import {
  buildSetupPhases,
  PLACEHOLDER_ADMIN_PASS,
  PLACEHOLDER_ADMIN_USER,
  PLACEHOLDER_WEB_BASE_PATH,
} from "./setupPhases";
import type { SshExecFn } from "./sshExec";
import { buildSshExecUsingSpawn } from "./sshExec";
import { runLiveSetupPhases } from "./setupLivePhaseLoop";

export type SetupPhaseResult = {
  id: string;
  title: string;
  script: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

export type SetupResult =
  | { mode: "dry-run"; phases: SetupPhaseResult[] }
  | { mode: "live"; phases: SetupPhaseResult[] };

type SetupEnv = Pick<Env, "masterKey">;

const XUI_LOCAL_PORT = 2053;

function randomAlnum(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[bytes[i]! % alphabet.length]!;
  return s;
}

export type ProfileSetupRow = {
  id: number;
  label: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  panel_hostname: string;
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
  xui_secrets_ciphertext: Uint8Array | null;
  xui_secrets_nonce: Uint8Array | null;
  xui_web_base_path: string | null;
  last_setup_error: string | null;
  last_setup_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExecuteProfileSetupOutcome =
  | { outcome: "dry-run"; profileRow: ProfileSetupRow; setup: Extract<SetupResult, { mode: "dry-run" }> }
  | { outcome: "live-success"; profileRow: ProfileSetupRow; setup: Extract<SetupResult, { mode: "live" }> }
  | { outcome: "live-failed"; profileRow: ProfileSetupRow; setup: Extract<SetupResult, { mode: "live" }> };

function getProfileForSetup(db: Database, id: number): ProfileSetupRow | null {
  return (
    db
      .query<ProfileSetupRow, [number]>(
        `SELECT
          id,
          label,
          host,
          ssh_port,
          ssh_user,
          operational_status,
          panel_hostname,
          ssh_password_ciphertext,
          ssh_password_nonce,
          xui_secrets_ciphertext,
          xui_secrets_nonce,
          xui_web_base_path,
          last_setup_error,
          last_setup_at,
          created_at,
          updated_at
        FROM vpn_profiles
        WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export async function executeProfileSetup(options: {
  db: Database;
  env: SetupEnv;
  profileId: number;
  sshExec?: SshExecFn;
}): Promise<ExecuteProfileSetupOutcome> {
  const { db, env, profileId } = options;
  const sshExec = options.sshExec ?? buildSshExecUsingSpawn();
  const settings = getAppSettings(db);

  const row = getProfileForSetup(db, profileId);
  if (!row) {
    throw Object.assign(new Error("not_found"), { status: 404 as const });
  }

  if (row.operational_status === "working") {
    throw Object.assign(new Error("already_working"), { status: 409 as const });
  }

  if (!row.panel_hostname || row.panel_hostname.trim() === "") {
    throw Object.assign(new Error("panel_hostname_required"), { status: 400 as const });
  }

  if (!settings.vpnSshEnabled) {
    const phases = buildSetupPhases({
      panelHostname: row.panel_hostname,
      acmeEmail: settings.acmeEmail,
      xuiLocalPort: XUI_LOCAL_PORT,
      adminUsername: PLACEHOLDER_ADMIN_USER,
      adminPassword: PLACEHOLDER_ADMIN_PASS,
      webBasePath: PLACEHOLDER_WEB_BASE_PATH,
    });
    return {
      outcome: "dry-run",
      profileRow: row,
      setup: {
        mode: "dry-run",
        phases: phases.map((p) => ({ id: p.id, title: p.title, script: p.script })),
      },
    };
  }

  const sshPassword = await decryptVpnPassword(
    env.masterKey,
    row.ssh_password_ciphertext,
    row.ssh_password_nonce,
  );

  const adminUsername = randomAlnum(12);
  const adminPassword = randomAlnum(24);
  const webBasePath = randomAlnum(18);

  const phases = buildSetupPhases({
    panelHostname: row.panel_hostname,
    acmeEmail: settings.acmeEmail,
    xuiLocalPort: XUI_LOCAL_PORT,
    adminUsername,
    adminPassword,
    webBasePath,
  });

  const neverAborted = new AbortController();
  const live = await runLiveSetupPhases({
    db,
    env,
    profileId,
    row: { host: row.host, ssh_port: row.ssh_port, ssh_user: row.ssh_user },
    phases,
    adminUsername,
    adminPassword,
    webBasePath,
    sshPassword,
    exec: sshExec,
    knownHostsFile: settings.sshKnownHostsFile ?? undefined,
    signal: neverAborted.signal,
  });

  const updated = getProfileForSetup(db, profileId)!;
  if (live.outcome === "live-failed") {
    return { outcome: "live-failed", profileRow: updated, setup: { mode: "live", phases: live.phases } };
  }
  return { outcome: "live-success", profileRow: updated, setup: { mode: "live", phases: live.phases } };
}
