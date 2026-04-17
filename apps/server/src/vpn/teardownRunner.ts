import type { Database } from "bun:sqlite";
import { getAppSettings } from "../db/appSettings";
import { decryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { buildTeardownPhases } from "./teardownPhases";
import type { ProfileSetupRow } from "./setupRunner";
import type { SshExecFn } from "./sshExec";
import { buildSshExecUsingSpawn } from "./sshExec";

export type TeardownPhaseResult = {
  id: string;
  title: string;
  script: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

export type TeardownResult =
  | { mode: "dry-run"; phases: TeardownPhaseResult[] }
  | { mode: "live"; phases: TeardownPhaseResult[] };

type TeardownEnv = Pick<Env, "masterKey">;

export type ExecuteProfileTeardownOutcome =
  | { outcome: "dry-run"; profileRow: ProfileSetupRow; teardown: Extract<TeardownResult, { mode: "dry-run" }> }
  | { outcome: "live-success"; profileRow: ProfileSetupRow; teardown: Extract<TeardownResult, { mode: "live" }> }
  | { outcome: "live-failed"; profileRow: ProfileSetupRow; teardown: Extract<TeardownResult, { mode: "live" }> };

const PHASE_TIMEOUT_MS = 600_000;

function getProfileForTeardown(db: Database, id: number): ProfileSetupRow | null {
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
          xui_panel_port,
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

export async function executeProfileTeardown(options: {
  db: Database;
  env: TeardownEnv;
  profileId: number;
  sshExec?: SshExecFn;
}): Promise<ExecuteProfileTeardownOutcome> {
  const { db, env, profileId } = options;
  const sshExec = options.sshExec ?? buildSshExecUsingSpawn();
  const settings = getAppSettings(db);

  const row = getProfileForTeardown(db, profileId);
  if (!row) {
    throw Object.assign(new Error("not_found"), { status: 404 as const });
  }

  if (!settings.vpnSshEnabled) {
    return {
      outcome: "dry-run",
      profileRow: row,
      teardown: {
        mode: "dry-run",
        phases: buildTeardownPhases().map((p) => ({ id: p.id, title: p.title, script: p.script })),
      },
    };
  }

  const eligible =
    row.operational_status === "working" ||
    (row.operational_status === "pending" &&
      row.last_setup_error != null &&
      row.last_setup_error.trim() !== "");
  if (!eligible) {
    throw Object.assign(new Error("clear_server_not_eligible"), { status: 400 as const });
  }

  const sshPassword = await decryptVpnPassword(
    env.masterKey,
    row.ssh_password_ciphertext,
    row.ssh_password_nonce,
  );

  const phases = buildTeardownPhases();
  const results: TeardownPhaseResult[] = [];

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
        knownHostsFile: settings.sshKnownHostsFile ?? undefined,
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
      const updated = getProfileForTeardown(db, profileId)!;
      return { outcome: "live-failed", profileRow: updated, teardown: { mode: "live", phases: results } };
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
      const updated = getProfileForTeardown(db, profileId)!;
      return { outcome: "live-failed", profileRow: updated, teardown: { mode: "live", phases: results } };
    }
  }

  db.query(
    `UPDATE vpn_profiles SET
      operational_status = 'pending',
      xui_secrets_ciphertext = NULL,
      xui_secrets_nonce = NULL,
      xui_web_base_path = NULL,
      xui_panel_port = NULL,
      last_setup_error = NULL,
      last_setup_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?`,
  ).run(profileId);

  const updated = getProfileForTeardown(db, profileId)!;
  return { outcome: "live-success", profileRow: updated, teardown: { mode: "live", phases: results } };
}
