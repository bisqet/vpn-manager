import type { Database } from "bun:sqlite";
import { encryptXuiSecretsJson } from "../crypto/xuiSecrets";
import { decryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import {
  buildSetupPhases,
  PLACEHOLDER_ADMIN_PASS,
  PLACEHOLDER_ADMIN_USER,
  PLACEHOLDER_WEB_BASE_PATH,
} from "./setupPhases";
import type { SshExecFn } from "./sshExec";
import { buildSshExecUsingSpawn, sshpassAvailable } from "./sshExec";

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

type SetupEnv = Pick<Env, "masterKey" | "vpnSshEnabled" | "acmeEmail" | "sshKnownHostsFile">;

const PHASE_TIMEOUT_MS = 600_000;
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
  const sshExecProvided = options.sshExec !== undefined;
  const sshExec = options.sshExec ?? buildSshExecUsingSpawn();

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

  if (!env.vpnSshEnabled) {
    const phases = buildSetupPhases({
      panelHostname: row.panel_hostname,
      acmeEmail: env.acmeEmail ?? "ops@example.com",
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

  if (!env.acmeEmail) {
    throw Object.assign(new Error("acme_email_required"), { status: 400 as const });
  }

  if (!sshExecProvided && !sshpassAvailable()) {
    throw Object.assign(new Error("sshpass_missing"), { status: 503 as const });
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
    acmeEmail: env.acmeEmail,
    xuiLocalPort: XUI_LOCAL_PORT,
    adminUsername,
    adminPassword,
    webBasePath,
  });

  const results: SetupPhaseResult[] = [];

  for (const phase of phases) {
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await sshExec({
        host: row.host,
        port: row.ssh_port,
        user: row.ssh_user,
        password: sshPassword,
        remoteScript: phase.script,
        timeoutMs: PHASE_TIMEOUT_MS,
        knownHostsFile: env.sshKnownHostsFile,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.query(
        `UPDATE vpn_profiles SET last_setup_error = ?, last_setup_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(message, profileId);
      results.push({
        id: phase.id,
        title: phase.title,
        script: phase.script,
        stdout: "",
        stderr: message,
        code: 1,
      });
      const updated = getProfileForSetup(db, profileId)!;
      return { outcome: "live-failed", profileRow: updated, setup: { mode: "live", phases: results } };
    }

    results.push({
      id: phase.id,
      title: phase.title,
      script: phase.script,
      stdout: res.stdout,
      stderr: res.stderr,
      code: res.code,
    });

    if (res.code !== 0) {
      const errSummary = `Phase ${phase.id} failed (exit ${res.code})`;
      db.query(
        `UPDATE vpn_profiles SET last_setup_error = ?, last_setup_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(`${errSummary}\n${res.stderr}`.slice(0, 4000), profileId);
      const updated = getProfileForSetup(db, profileId)!;
      return { outcome: "live-failed", profileRow: updated, setup: { mode: "live", phases: results } };
    }
  }

  const { ciphertext, nonce } = await encryptXuiSecretsJson(env.masterKey, {
    v: 1,
    adminUsername,
    adminPassword,
  });

  db.query(
    `UPDATE vpn_profiles SET
      operational_status = 'working',
      xui_secrets_ciphertext = ?,
      xui_secrets_nonce = ?,
      xui_web_base_path = ?,
      last_setup_error = NULL,
      last_setup_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?`,
  ).run(ciphertext, nonce, webBasePath, profileId);

  const updated = getProfileForSetup(db, profileId)!;
  return { outcome: "live-success", profileRow: updated, setup: { mode: "live", phases: results } };
}
