import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import { migrate } from "../db/migrate";
import type { Env } from "../env";
import { runLiveSetupPhases } from "./setupLivePhaseLoop";
import type { SshExecFn } from "./sshExec";

const env: Pick<Env, "masterKey"> = {
  masterKey: new Uint8Array(32).fill(9),
};

describe("runLiveSetupPhases", () => {
  let db: Database;
  let profileId: number;
  const okExec: SshExecFn = async () => ({ code: 0, stdout: "", stderr: "" });

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);

    const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, "ssh-secret");
    db.query(
      `INSERT INTO vpn_profiles (
        label, host, ssh_port, ssh_user,
        ssh_password_ciphertext, ssh_password_nonce,
        operational_status, panel_hostname
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run("t", "1.2.3.4", 22, "root", ciphertext, nonce, "panel.example.com");

    profileId = Number(db.query<{ id: number }, []>("SELECT id FROM vpn_profiles LIMIT 1").get()!.id);
  });

  test("marks profile working and stores x-ui secrets after all phases succeed", async () => {
    const live = await runLiveSetupPhases({
      db,
      env,
      profileId,
      row: { host: "1.2.3.4", ssh_port: 22, ssh_user: "root" },
      phases: [{ id: "only", title: "Only", script: "true" }],
      adminUsername: "admuser12",
      adminPassword: "admpass24charslongxx",
      webBasePath: "webbasepath18chars",
      sshPassword: "ssh-secret",
      exec: okExec,
      knownHostsFile: undefined,
      signal: new AbortController().signal,
    });

    expect(live.outcome).toBe("live-success");
    expect(live.phases).toEqual([
      expect.objectContaining({
        id: "only",
        title: "Only",
        script: "true",
        code: 0,
        stdout: "",
        stderr: "",
      }),
    ]);

    const row = db
      .query<{
        operational_status: string;
        xui_secrets_ciphertext: Uint8Array | null;
        xui_secrets_nonce: Uint8Array | null;
        xui_web_base_path: string | null;
        last_setup_error: string | null;
      }, [number]>(
        `SELECT operational_status, xui_secrets_ciphertext, xui_secrets_nonce, xui_web_base_path, last_setup_error
         FROM vpn_profiles WHERE id = ?`,
      )
      .get(profileId)!;

    expect(row.operational_status).toBe("working");
    expect(row.xui_secrets_ciphertext).not.toBeNull();
    expect(row.xui_secrets_nonce).not.toBeNull();
    expect(row.xui_web_base_path).toBe("webbasepath18chars");
    expect(row.last_setup_error).toBeNull();
  });

  test("aborted signal before first phase yields live-failed and cancel error in DB", async () => {
    const ac = new AbortController();
    ac.abort();

    const live = await runLiveSetupPhases({
      db,
      env,
      profileId,
      row: { host: "1.2.3.4", ssh_port: 22, ssh_user: "root" },
      phases: [{ id: "a", title: "T", script: "true" }],
      adminUsername: "u",
      adminPassword: "p",
      webBasePath: "path",
      sshPassword: "ssh-secret",
      exec: okExec,
      knownHostsFile: undefined,
      signal: ac.signal,
    });

    expect(live.outcome).toBe("live-failed");
    expect(live.phases).toEqual([
      expect.objectContaining({
        id: "a",
        stderr: "Setup cancelled",
        code: 1,
      }),
    ]);

    const lastErr = db
      .query<{ last_setup_error: string | null; operational_status: string }, [number]>(
        "SELECT last_setup_error, operational_status FROM vpn_profiles WHERE id = ?",
      )
      .get(profileId)!;

    expect(lastErr.last_setup_error).toBe("Setup cancelled");
    expect(lastErr.operational_status).toBe("pending");
  });
});
