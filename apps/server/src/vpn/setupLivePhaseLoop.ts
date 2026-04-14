import type { Database } from "bun:sqlite";
import { encryptXuiSecretsJson } from "../crypto/xuiSecrets";
import type { Env } from "../env";
import type { SshExecFn } from "./sshExec";

/** Matches the shape returned from live setup in `setupRunner.ts`. */
export type SetupPhaseResult = {
  id: string;
  title: string;
  script: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

export async function runLiveSetupPhases(options: {
  db: Database;
  env: Pick<Env, "masterKey">;
  profileId: number;
  row: { host: string; ssh_port: number; ssh_user: string };
  phases: Array<{ id: string; title: string; script: string }>;
  adminUsername: string;
  adminPassword: string;
  webBasePath: string;
  sshPassword: string;
  exec: SshExecFn;
  knownHostsFile: string | undefined;
  signal: AbortSignal;
}): Promise<{ outcome: "live-success" | "live-failed"; phases: SetupPhaseResult[] }> {
  const {
    db,
    env,
    profileId,
    row,
    phases,
    adminUsername,
    adminPassword,
    webBasePath,
    sshPassword,
    exec,
    knownHostsFile,
    signal,
  } = options;

  const results: SetupPhaseResult[] = [];

  for (const phase of phases) {
    if (signal.aborted) {
      const message = "Setup cancelled";
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
      return { outcome: "live-failed", phases: results };
    }

    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await exec({
        host: row.host,
        port: row.ssh_port,
        user: row.ssh_user,
        password: sshPassword,
        remoteScript: phase.script,
        timeoutMs: 600_000,
        knownHostsFile,
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
      return { outcome: "live-failed", phases: results };
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
      return { outcome: "live-failed", phases: results };
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

  return { outcome: "live-success", phases: results };
}
