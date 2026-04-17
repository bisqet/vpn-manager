import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import type { UpgradeWebSocket } from "hono/ws";
import { SESSION_COOKIE } from "../auth/cookie";
import { getSessionUserId } from "../auth/session";
import { decryptXuiSecretsJson, encryptXuiSecretsJson } from "../crypto/xuiSecrets";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { getAppSettings } from "../db/appSettings";
import { runPanelReachabilityProbe, schedulePanelReachabilityProbe } from "../net/panelReachabilityProbe";
import { buildPanelHttpsUrl, resolvePanelHostname } from "../net/panelAddress";
import { vpnProfileCreate, vpnProfileUpdate } from "../types";
import { createProfileSetupTerminalWebSocketHandlers } from "../vpn/profileSetupTerminalBridge";
import { resolveProfileSetupTerminal } from "../vpn/profileSetupTerminalGate";
import { createProfileSshWebSocketHandlers } from "../vpn/profileSshBridge";
import { resolveProfileSshTerminal } from "../vpn/profileSshTerminalGate";
import { executeProfileSetup } from "../vpn/setupRunner";
import { executeProfileTeardown } from "../vpn/teardownRunner";
import type { SshExecFn } from "../vpn/sshExec";

type VpnProfileRow = {
  id: number;
  label: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  panel_hostname: string;
  last_setup_error: string | null;
  xui_web_base_path: string | null;
  xui_panel_port: number | null;
  panel_reachability: string;
  panel_reachability_detail: string | null;
  panel_reachability_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type VpnProfileSecretRow = VpnProfileRow & {
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
  xui_secrets_ciphertext: Uint8Array | null;
  xui_secrets_nonce: Uint8Array | null;
};

type ProfilesEnv = Pick<Env, "masterKey">;

export type ProfilesRoutesOptions = {
  sshExec?: SshExecFn;
  upgradeWebSocket?: UpgradeWebSocket;
  reachabilityProbeRunner?: (opts: {
    db: Database;
    profileId: number;
    fetchFn?: typeof fetch;
  }) => void | Promise<void>;
};

function toProfileDto(row: VpnProfileRow, userId: number | null) {
  const panelPort =
    row.xui_panel_port == null ? null : Number(row.xui_panel_port);
  const panelUrl =
    userId !== null && row.operational_status === "working"
      ? buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path, panelPort)
      : null;
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
    panelHostname: row.panel_hostname,
    operationalStatus: row.operational_status as "pending" | "working",
    lastSetupError: row.last_setup_error ?? null,
    panelReachability: row.panel_reachability as "unknown" | "checking" | "reachable" | "unreachable",
    panelReachabilityDetail: row.panel_reachability_detail ?? null,
    panelReachabilityCheckedAt: row.panel_reachability_checked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    panelUrl,
  };
}

async function readJson(c: Context) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }

  return id;
}

function normalizeWebBasePath(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getProfileById(db: Database, id: number): VpnProfileSecretRow | null {
  return (
    db
      .query<VpnProfileSecretRow, [number]>(
        `SELECT
          id,
          label,
          host,
          ssh_port,
          ssh_user,
          operational_status,
          panel_hostname,
          last_setup_error,
          xui_web_base_path,
          xui_panel_port,
          panel_reachability,
          panel_reachability_detail,
          panel_reachability_checked_at,
          ssh_password_ciphertext,
          ssh_password_nonce,
          xui_secrets_ciphertext,
          xui_secrets_nonce,
          created_at,
          updated_at
        FROM vpn_profiles
        WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function profilesRoutes(db: Database, env: ProfilesEnv, options: ProfilesRoutesOptions = {}) {
  const app = new Hono();
  const uw = options.upgradeWebSocket ?? upgradeWebSocket;
  const runReachability =
    options.reachabilityProbeRunner ??
    ((o: { db: Database; profileId: number; fetchFn?: typeof fetch }) => {
      void runPanelReachabilityProbe(o);
    });

  app.get("/", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);
    const rows = db
      .query<VpnProfileRow>(
        `SELECT
          id,
          label,
          host,
          ssh_port,
          ssh_user,
          operational_status,
          panel_hostname,
          last_setup_error,
          xui_web_base_path,
          xui_panel_port,
          panel_reachability,
          panel_reachability_detail,
          panel_reachability_checked_at,
          created_at,
          updated_at
        FROM vpn_profiles
        ORDER BY id ASC`,
      )
      .all();

    return c.json(rows.map((row) => toProfileDto(row, userId)));
  });

  /** Browser SSH cannot read JSON from failed WS upgrades; check this before opening the socket. */
  app.get("/ssh-terminal/preflight", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);
    if (userId === null) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ sshTerminalEnabled: getAppSettings(db).vpnSshEnabled });
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    const parsed = vpnProfileCreate.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid VPN profile payload", details: parsed.error.flatten() }, 400);
    }

    const {
      label,
      host,
      sshPort,
      sshUser,
      sshPassword,
      panelHostname,
      panelAdminUsername,
      panelAdminPassword,
      panelWebBasePath,
      panelHttpsPort,
    } = parsed.data;
    const hostTrimmed = host.trim();
    const panelRaw = panelHostname?.trim() ?? "";
    const resolved = resolvePanelHostname({ host: hostTrimmed, panel: panelRaw });
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, 400);
    }

    const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, sshPassword);
    const webPath = normalizeWebBasePath(panelWebBasePath);
    const panelPort = panelHttpsPort ?? null;
    const adminUsername = (panelAdminUsername ?? "").trim();
    const adminPassword = (panelAdminPassword ?? "").trim();
    let xuiCiphertext: Uint8Array | null = null;
    let xuiNonce: Uint8Array | null = null;
    if (adminUsername !== "" && adminPassword !== "") {
      const encryptedXuiSecrets = await encryptXuiSecretsJson(env.masterKey, {
        v: 1,
        adminUsername,
        adminPassword,
      });
      xuiCiphertext = encryptedXuiSecrets.ciphertext;
      xuiNonce = encryptedXuiSecrets.nonce;
    }

    const result = db
      .query(
        `INSERT INTO vpn_profiles (
          label,
          host,
          ssh_port,
          ssh_user,
          ssh_password_ciphertext,
          ssh_password_nonce,
          panel_hostname,
          xui_secrets_ciphertext,
          xui_secrets_nonce,
          xui_web_base_path,
          xui_panel_port,
          panel_reachability,
          panel_reachability_detail,
          panel_reachability_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checking', NULL, NULL)`,
      )
      .run(
        label,
        hostTrimmed,
        sshPort,
        sshUser,
        ciphertext,
        nonce,
        resolved.panel,
        xuiCiphertext,
        xuiNonce,
        webPath,
        panelPort,
      );

    const newId = Number(result.lastInsertRowid);
    const created = getProfileById(db, newId);
    if (options.reachabilityProbeRunner) {
      await Promise.resolve(runReachability({ db, profileId: newId }));
    } else {
      schedulePanelReachabilityProbe({ db, profileId: newId });
    }
    const sessionUserId = getSessionUserId(db, getCookie(c, SESSION_COOKIE));
    return c.json(toProfileDto(created!, sessionUserId), 201);
  });

  app.post("/:id/setup", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (existing.operational_status === "working") {
      return c.json(
        { error: "Profile is already set up (working). Reset is not available yet." },
        409,
      );
    }

    if (!existing.panel_hostname || existing.panel_hostname.trim() === "") {
      return c.json({ error: "panelHostname is required before setup" }, 400);
    }

    const setupAppSettings = getAppSettings(db);
    if (setupAppSettings.vpnSshEnabled) {
      return c.json(
        {
          error: "Live setup runs in the browser terminal",
          useSetupTerminal: true,
        },
        410,
      );
    }

    try {
      const result = await executeProfileSetup({
        db,
        env: { masterKey: env.masterKey },
        profileId: id,
      });

      const setupSessionUserId = getSessionUserId(db, getCookie(c, SESSION_COOKIE));
      return c.json({
        profile: toProfileDto(result.profileRow as VpnProfileRow, setupSessionUserId),
        setup: result.setup,
      });
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      if (err.status === 409) {
        return c.json({ error: "Profile is already set up (working). Reset is not available yet." }, 409);
      }
      if (err.status === 400) {
        if (err.message === "panel_hostname_required") {
          return c.json({ error: "panelHostname is required before setup" }, 400);
        }
      }
      throw e;
    }
  });

  function jsonForSetupTerminalGateFailure(
    status: 400 | 401 | 403 | 404 | 409,
    profileId: number | null,
  ): { error: string } {
    if (status === 401) return { error: "Unauthorized" };
    if (status === 403) return { error: "SSH is disabled on this server" };
    if (status === 404) return { error: "Profile not found" };
    if (status === 409) {
      return { error: "Profile is already set up (working). Reset is not available yet." };
    }
    if (profileId === null || !Number.isInteger(profileId) || profileId < 1) {
      return { error: "Invalid VPN profile id" };
    }
    return { error: "panelHostname is required before setup" };
  }

  app.post("/:id/clear-server", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
    }

    try {
      const result = await executeProfileTeardown({
        db,
        env: { masterKey: env.masterKey },
        profileId: id,
        sshExec: options.sshExec,
      });

      if (result.outcome === "dry-run") {
        return c.json({
          profile: toProfileDto(result.profileRow as VpnProfileRow),
          teardown: result.teardown,
        });
      }

      if (result.outcome === "live-failed") {
        return c.json(
          {
            error: "VPN clear-server failed",
            profile: toProfileDto(result.profileRow as VpnProfileRow),
            teardown: result.teardown,
          },
          500,
        );
      }

      return c.json({
        profile: toProfileDto(result.profileRow as VpnProfileRow),
        teardown: result.teardown,
      });
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      if (err.status === 400 && err.message === "clear_server_not_eligible") {
        return c.json(
          { error: "Nothing to clear: profile is pending and setup did not record a failure." },
          400,
        );
      }
      throw e;
    }
  });

  app.patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
    }

    const rawBody = await readJson(c);
    const body =
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? { ...rawBody } : rawBody;

    if (body && typeof body === "object" && body.sshPassword === "") {
      delete body.sshPassword;
    }
    if (body && typeof body === "object" && body.panelAdminPassword === "") {
      delete body.panelAdminPassword;
    }

    const parsed = vpnProfileUpdate.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid VPN profile payload", details: parsed.error.flatten() }, 400);
    }

    const {
      label,
      host,
      sshPort,
      sshUser,
      sshPassword,
      panelHostname,
      panelAdminUsername,
      panelAdminPassword,
      panelWebBasePath,
      panelHttpsPort,
    } = parsed.data;

    const mergedHost = (host ?? existing.host).trim();
    const mergedPanelRaw =
      panelHostname !== undefined ? panelHostname.trim() : existing.panel_hostname.trim();
    const resolved = resolvePanelHostname({ host: mergedHost, panel: mergedPanelRaw });
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, 400);
    }

    let ciphertext = existing.ssh_password_ciphertext;
    let nonce = existing.ssh_password_nonce;
    if (sshPassword) {
      const encrypted = await encryptVpnPassword(env.masterKey, sshPassword);
      ciphertext = encrypted.ciphertext;
      nonce = encrypted.nonce;
    }

    const mergedWebPath =
      panelWebBasePath !== undefined ? normalizeWebBasePath(panelWebBasePath) : existing.xui_web_base_path;
    const existingComparableWebPath = normalizeWebBasePath(existing.xui_web_base_path ?? undefined);
    const mergedComparableWebPath = normalizeWebBasePath(mergedWebPath ?? undefined);
    const mergedPanelPort = panelHttpsPort !== undefined ? panelHttpsPort : existing.xui_panel_port;
    let xuiCiphertext = existing.xui_secrets_ciphertext;
    let xuiNonce = existing.xui_secrets_nonce;
    let secretsChanged = false;
    const adminUsername = (panelAdminUsername ?? "").trim();
    const adminPassword = (panelAdminPassword ?? "").trim();
    if (adminUsername !== "" && adminPassword !== "") {
      const encryptedSecrets = await encryptXuiSecretsJson(env.masterKey, {
        v: 1,
        adminUsername,
        adminPassword,
      });
      xuiCiphertext = encryptedSecrets.ciphertext;
      xuiNonce = encryptedSecrets.nonce;
      secretsChanged = true;
    }
    const panelTouched =
      resolved.panel !== existing.panel_hostname.trim() ||
      mergedComparableWebPath !== existingComparableWebPath ||
      mergedPanelPort !== existing.xui_panel_port ||
      secretsChanged;
    const resetReachabilityClause = panelTouched
      ? `,
        panel_reachability = 'checking',
        panel_reachability_detail = NULL,
        panel_reachability_checked_at = NULL`
      : "";

    db.query(
      `UPDATE vpn_profiles
      SET
        label = ?,
        host = ?,
        ssh_port = ?,
        ssh_user = ?,
        ssh_password_ciphertext = ?,
        ssh_password_nonce = ?,
        panel_hostname = ?,
        xui_web_base_path = ?,
        xui_panel_port = ?,
        xui_secrets_ciphertext = ?,
        xui_secrets_nonce = ?,
        updated_at = datetime('now')${resetReachabilityClause}
      WHERE id = ?`,
    ).run(
      label ?? existing.label,
      mergedHost,
      sshPort ?? existing.ssh_port,
      sshUser ?? existing.ssh_user,
      ciphertext,
      nonce,
      resolved.panel,
      mergedWebPath,
      mergedPanelPort,
      xuiCiphertext,
      xuiNonce,
      id,
    );

    const updated = getProfileById(db, id);
    if (panelTouched) {
      if (options.reachabilityProbeRunner) {
        await Promise.resolve(runReachability({ db, profileId: id }));
      } else {
        schedulePanelReachabilityProbe({ db, profileId: id });
      }
    }
    const patchSessionUserId = getSessionUserId(db, getCookie(c, SESSION_COOKIE));
    return c.json(toProfileDto(updated!, patchSessionUserId));
  });

  function deleteVpnProfileWithHopCleanup(db: Database, id: number) {
    const affectedRows = db
      .query<{ chain_id: number }, [number]>("SELECT DISTINCT chain_id FROM chain_hops WHERE vpn_profile_id = ?")
      .all(id);
    const affectedChainIds = affectedRows.map((r) => r.chain_id);

    db.query("DELETE FROM chain_hops WHERE vpn_profile_id = ?").run(id);

    for (const chainId of affectedChainIds) {
      const remaining = db
        .query<{ id: number }, [number]>(
          "SELECT id FROM chain_hops WHERE chain_id = ? ORDER BY position ASC, id ASC",
        )
        .all(chainId);

      if (remaining.length === 0) {
        db.query("DELETE FROM chains WHERE id = ?").run(chainId);
        continue;
      }

      for (let i = 0; i < remaining.length; i++) {
        db.query("UPDATE chain_hops SET position = ? WHERE id = ?").run(i, remaining[i].id);
      }
    }

    db.query("DELETE FROM vpn_profiles WHERE id = ?").run(id);
  }

  app.delete("/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
    }

    const rawForce = c.req.query("force");
    if (rawForce !== undefined && rawForce !== "true" && rawForce !== "1") {
      return c.json({ error: "Invalid force parameter" }, 400);
    }

    if (rawForce === "true" || rawForce === "1") {
      db.exec("BEGIN");
      try {
        deleteVpnProfileWithHopCleanup(db, id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return c.json({ ok: true });
    }

    try {
      db.query("DELETE FROM vpn_profiles WHERE id = ?").run(id);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "Profile is in use by one or more chain hops" }, 409);
      }

      throw error;
    }
  });

  app.get("/:id/panel-login", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid VPN profile id" }, 400);
    }

    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);
    if (userId === null) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const row =
      db
        .query<
          {
            operational_status: string;
            panel_hostname: string;
            xui_web_base_path: string | null;
            xui_panel_port: number | null;
            xui_secrets_ciphertext: Uint8Array | null;
            xui_secrets_nonce: Uint8Array | null;
          },
          [number]
        >(
          `SELECT operational_status, panel_hostname, xui_web_base_path, xui_panel_port,
                xui_secrets_ciphertext, xui_secrets_nonce
         FROM vpn_profiles WHERE id = ?`,
        )
        .get(id) ?? null;

    if (!row) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (row.operational_status !== "working") {
      return c.json({ error: "Panel login is only available after successful setup" }, 409);
    }
    if (!row.xui_secrets_ciphertext || !row.xui_secrets_nonce || !row.xui_web_base_path) {
      return c.json({ error: "Panel credentials are not available for this profile" }, 409);
    }

    let secrets;
    try {
      secrets = await decryptXuiSecretsJson(env.masterKey, row.xui_secrets_ciphertext, row.xui_secrets_nonce);
    } catch {
      return c.json({ error: "Panel credentials are not available for this profile" }, 409);
    }
    if (secrets.v !== 1) {
      return c.json({ error: "Panel credentials are not available for this profile" }, 409);
    }

    const panelPort = row.xui_panel_port == null ? null : Number(row.xui_panel_port);
    const panelUrl = buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path, panelPort);
    if (!panelUrl) {
      return c.json({ error: "Panel credentials are not available for this profile" }, 409);
    }

    return c.json({
      panelUrl,
      adminUsername: secrets.adminUsername,
      adminPassword: secrets.adminPassword,
    });
  });

  app.get(
    "/:id/ssh",
    async (c, next) => {
      const upgrade = c.req.header("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return c.json({ error: "Expected WebSocket upgrade" }, 426);
      }

      const id = parseId(c.req.param("id"));
      if (id === null) {
        return c.json({ error: "Invalid VPN profile id" }, 400);
      }

      const token = getCookie(c, SESSION_COOKIE);
      const userId = getSessionUserId(db, token);
      const appSettings = getAppSettings(db);

      const gate = await resolveProfileSshTerminal({
        db,
        masterKey: env.masterKey,
        vpnSshEnabled: appSettings.vpnSshEnabled,
        userId,
        profileId: id,
      });

      if (!gate.ok) {
        const message =
          gate.status === 401
            ? "Unauthorized"
            : gate.status === 403
              ? "SSH is disabled on this server"
              : gate.status === 400
                ? "Invalid VPN profile id"
                : "Profile not found";
        return c.json({ error: message }, gate.status);
      }

      c.set("sshTerminalGate", gate);
      await next();
    },
    uw((c) => {
      const gate = c.get("sshTerminalGate");
      const appSettings = getAppSettings(db);
      return createProfileSshWebSocketHandlers({
        row: gate.row,
        sshPassword: gate.sshPassword,
        env: { sshKnownHostsFile: appSettings.sshKnownHostsFile ?? undefined },
      });
    }),
  );

  app.get(
    "/:id/setup-terminal",
    async (c, next) => {
      const upgrade = c.req.header("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return c.json({ error: "Expected WebSocket upgrade" }, 426);
      }

      const setupTerminalProfileId = parseId(c.req.param("id"));
      if (setupTerminalProfileId === null) {
        return c.json({ error: "Invalid VPN profile id" }, 400);
      }

      const token = getCookie(c, SESSION_COOKIE);
      const setupTerminalUserId = getSessionUserId(db, token);
      const setupTerminalAppSettings = getAppSettings(db);

      const setupGate = await resolveProfileSetupTerminal({
        db,
        masterKey: env.masterKey,
        vpnSshEnabled: setupTerminalAppSettings.vpnSshEnabled,
        userId: setupTerminalUserId,
        profileId: setupTerminalProfileId,
      });

      if (!setupGate.ok) {
        return c.json(
          jsonForSetupTerminalGateFailure(setupGate.status, setupTerminalProfileId),
          setupGate.status,
        );
      }

      c.set("setupTerminalGate", setupGate);
      await next();
    },
    uw((c) => {
      const gate = c.get("setupTerminalGate");
      return createProfileSetupTerminalWebSocketHandlers({
        db,
        env: { masterKey: env.masterKey },
        profileId: gate.row.id,
        row: gate.row,
        sshPassword: gate.sshPassword,
        getAppSettings: () => getAppSettings(db),
      });
    }),
  );

  return app;
}
