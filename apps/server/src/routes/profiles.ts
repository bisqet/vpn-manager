import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import type { UpgradeWebSocket } from "hono/ws";
import { SESSION_COOKIE } from "../auth/cookie";
import { getSessionUserId } from "../auth/session";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { resolvePanelHostname } from "../net/panelAddress";
import { vpnProfileCreate, vpnProfileUpdate } from "../types";
import { verifyProfileHealthPlaceholder } from "../vpn/profileOperationalPlaceholder";
import { createProfileSshWebSocketHandlers } from "../vpn/profileSshBridge";
import { resolveProfileSshTerminal } from "../vpn/profileSshTerminalGate";
import { executeProfileSetup } from "../vpn/setupRunner";
import type { SshExecFn } from "../vpn/sshExec";

type VpnProfileRow = {
  id: number;
  label: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  panel_hostname: string;
  created_at: string;
  updated_at: string;
};

type VpnProfileSecretRow = VpnProfileRow & {
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
};

type ProfilesEnv = Pick<Env, "masterKey" | "vpnSshEnabled" | "acmeEmail" | "sshKnownHostsFile">;

export type ProfilesRoutesOptions = {
  sshExec?: SshExecFn;
  upgradeWebSocket?: UpgradeWebSocket;
};

function toProfileDto(row: VpnProfileRow) {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
    panelHostname: row.panel_hostname,
    operationalStatus: row.operational_status as "pending" | "working",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
          ssh_password_ciphertext,
          ssh_password_nonce,
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

  app.get("/", (c) => {
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
          created_at,
          updated_at
        FROM vpn_profiles
        ORDER BY id ASC`,
      )
      .all();

    return c.json(rows.map(toProfileDto));
  });

  /** Browser SSH cannot read JSON from failed WS upgrades; check this before opening the socket. */
  app.get("/ssh-terminal/preflight", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);
    if (userId === null) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ sshTerminalEnabled: env.vpnSshEnabled });
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    const parsed = vpnProfileCreate.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid VPN profile payload", details: parsed.error.flatten() }, 400);
    }

    const { label, host, sshPort, sshUser, sshPassword, panelHostname } = parsed.data;
    const hostTrimmed = host.trim();
    const panelRaw = panelHostname?.trim() ?? "";
    const resolved = resolvePanelHostname({ host: hostTrimmed, panel: panelRaw });
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, 400);
    }

    const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, sshPassword);

    const result = db
      .query(
        `INSERT INTO vpn_profiles (
          label,
          host,
          ssh_port,
          ssh_user,
          ssh_password_ciphertext,
          ssh_password_nonce,
          panel_hostname
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(label, hostTrimmed, sshPort, sshUser, ciphertext, nonce, resolved.panel);

    const created = getProfileById(db, Number(result.lastInsertRowid));
    return c.json(toProfileDto(created!), 201);
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

    try {
      const result = await executeProfileSetup({
        db,
        env,
        profileId: id,
        sshExec: options.sshExec,
      });

      if (result.outcome === "dry-run") {
        return c.json({
          profile: toProfileDto(result.profileRow as VpnProfileRow),
          setup: result.setup,
        });
      }

      if (result.outcome === "live-failed") {
        return c.json(
          {
            error: "VPN setup failed",
            profile: toProfileDto(result.profileRow as VpnProfileRow),
            setup: result.setup,
          },
          500,
        );
      }

      return c.json({
        profile: toProfileDto(result.profileRow as VpnProfileRow),
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
        if (err.message === "acme_email_required") {
          return c.json(
            { error: "ACME_EMAIL is required on the server when VPN_SSH_ENABLED is true" },
            400,
          );
        }
      }
      if (err.status === 503) {
        return c.json(
          {
            error:
              "sshpass is required on the VPN Manager host for SSH password authentication (install the sshpass package)",
          },
          503,
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

    const parsed = vpnProfileUpdate.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid VPN profile payload", details: parsed.error.flatten() }, 400);
    }

    const { label, host, sshPort, sshUser, sshPassword, panelHostname } = parsed.data;

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
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(
      label ?? existing.label,
      mergedHost,
      sshPort ?? existing.ssh_port,
      sshUser ?? existing.ssh_user,
      ciphertext,
      nonce,
      resolved.panel,
      id,
    );

    const nextStatus = await verifyProfileHealthPlaceholder();
    db.query(
      "UPDATE vpn_profiles SET operational_status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(nextStatus, id);

    const updated = getProfileById(db, id);
    return c.json(toProfileDto(updated!));
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

      const gate = await resolveProfileSshTerminal({
        db,
        masterKey: env.masterKey,
        vpnSshEnabled: env.vpnSshEnabled,
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
      return createProfileSshWebSocketHandlers({
        row: gate.row,
        sshPassword: gate.sshPassword,
        env: { sshKnownHostsFile: env.sshKnownHostsFile },
      });
    }),
  );

  return app;
}
