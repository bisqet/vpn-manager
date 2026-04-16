import type { Database } from "bun:sqlite";
import type { Env } from "../env";
import { getAppSettings } from "../db/appSettings";

export type SetupPhaseResult = {
  id: string;
  title: string;
  script: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

export type SetupResult = { mode: "dry-run"; phases: SetupPhaseResult[] };

type SetupEnv = Pick<Env, "masterKey">;

const UPSTREAM_INSTALL_SH_CMD =
  "bash <(curl -fsSL https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh)";

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

export type ExecuteProfileSetupOutcome = {
  outcome: "dry-run";
  profileRow: ProfileSetupRow;
  setup: SetupResult;
};

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

function dryRunInstallShPhase(): SetupPhaseResult {
  return {
    id: "upstream_install_sh",
    title: "3x-ui (upstream install.sh)",
    script: `When VPN_SSH_ENABLED is true, live provisioning runs only in the browser **Setup** terminal (WebSocket).

On the target host as root, the server drives the same non-login shell and runs:

${UPSTREAM_INSTALL_SH_CMD}

Prompts are answered automatically; panel credentials are parsed from the script output.`,
  };
}

/**
 * Returns a **dry-run** description when `vpnSshEnabled` is false.
 * When SSH is enabled, live setup uses `GET /api/profiles/:id/setup-terminal` only — this function **rejects**.
 */
export async function executeProfileSetup(options: {
  db: Database;
  env: SetupEnv;
  profileId: number;
}): Promise<ExecuteProfileSetupOutcome> {
  const { db, profileId } = options;
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

  if (settings.vpnSshEnabled) {
    throw Object.assign(new Error("live_setup_requires_setup_terminal"), { status: 501 as const });
  }

  return {
    outcome: "dry-run",
    profileRow: row,
    setup: {
      mode: "dry-run",
      phases: [dryRunInstallShPhase()],
    },
  };
}
