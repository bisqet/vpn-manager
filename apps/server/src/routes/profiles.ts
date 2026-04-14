import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { vpnProfileCreate, vpnProfileUpdate } from "../types";
import { simulateSetupWork, verifyProfileHealthPlaceholder } from "../vpn/profileOperationalPlaceholder";

type VpnProfileRow = {
  id: number;
  label: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  operational_status: string;
  created_at: string;
  updated_at: string;
};

type VpnProfileSecretRow = VpnProfileRow & {
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
};

type ProfilesEnv = Pick<Env, "masterKey">;

function toProfileDto(row: VpnProfileRow) {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
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

export function profilesRoutes(db: Database, env: ProfilesEnv) {
  const app = new Hono();

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
          created_at,
          updated_at
        FROM vpn_profiles
        ORDER BY id ASC`,
      )
      .all();

    return c.json(rows.map(toProfileDto));
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    const parsed = vpnProfileCreate.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid VPN profile payload", details: parsed.error.flatten() }, 400);
    }

    const { label, host, sshPort, sshUser, sshPassword } = parsed.data;
    const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, sshPassword);

    const result = db
      .query(
        `INSERT INTO vpn_profiles (
          label,
          host,
          ssh_port,
          ssh_user,
          ssh_password_ciphertext,
          ssh_password_nonce
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(label, host, sshPort, sshUser, ciphertext, nonce);

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

    await simulateSetupWork();
    const status = await verifyProfileHealthPlaceholder();

    db.query(
      "UPDATE vpn_profiles SET operational_status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, id);

    const updated = getProfileById(db, id);
    return c.json(toProfileDto(updated!));
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

    const { label, host, sshPort, sshUser, sshPassword } = parsed.data;

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
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(
      label ?? existing.label,
      host ?? existing.host,
      sshPort ?? existing.ssh_port,
      sshUser ?? existing.ssh_user,
      ciphertext,
      nonce,
      id,
    );

    const nextStatus = await verifyProfileHealthPlaceholder();
    db.query(
      "UPDATE vpn_profiles SET operational_status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(nextStatus, id);

    const updated = getProfileById(db, id);
    return c.json(toProfileDto(updated!));
  });

  app.delete("/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
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

  return app;
}
