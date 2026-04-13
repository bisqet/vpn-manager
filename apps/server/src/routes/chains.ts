import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { buildExportV1, ExportNotFoundError } from "../export/buildExport";

type ChainRow = {
  chain_id: number;
  chain_name: string;
  vpn_profile_id: number | null;
};

type ChainDto = {
  id: number;
  name: string;
  vpnProfileIds: number[];
};

type ChainCreateBody = {
  name: string;
  vpnProfileIds: number[];
};

type ChainUpdateBody = {
  name?: string;
  vpnProfileIds?: number[];
};

function routingProfileName(chainName: string) {
  return `${chainName} routing`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeVpnProfileIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: number[] = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 1) {
      return null;
    }
    ids.push(item);
  }

  return ids;
}

function validateCreateBody(body: unknown):
  | { ok: true; value: ChainCreateBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid chain payload" };
  }

  const name = normalizeName(body.name);
  if (!name) {
    return { ok: false, error: "Invalid chain payload" };
  }

  const vpnProfileIds = normalizeVpnProfileIds(body.vpnProfileIds);
  if (!vpnProfileIds) {
    return { ok: false, error: "Invalid chain payload" };
  }

  const idsValidation = validateVpnProfileIds(vpnProfileIds);
  if (!idsValidation.ok) {
    return idsValidation;
  }

  return { ok: true, value: { name, vpnProfileIds } };
}

function validateUpdateBody(body: unknown):
  | { ok: true; value: ChainUpdateBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid chain payload" };
  }

  const result: ChainUpdateBody = {};

  if ("name" in body) {
    const name = normalizeName(body.name);
    if (!name) {
      return { ok: false, error: "Invalid chain payload" };
    }
    result.name = name;
  }

  if ("vpnProfileIds" in body) {
    const vpnProfileIds = normalizeVpnProfileIds(body.vpnProfileIds);
    if (!vpnProfileIds) {
      return { ok: false, error: "Invalid chain payload" };
    }

    const idsValidation = validateVpnProfileIds(vpnProfileIds);
    if (!idsValidation.ok) {
      return idsValidation;
    }

    result.vpnProfileIds = vpnProfileIds;
  }

  return { ok: true, value: result };
}

function validateVpnProfileIds(ids: number[]):
  | { ok: true }
  | { ok: false; error: string } {
  if (ids.length === 0) {
    return { ok: false, error: "vpnProfileIds must contain at least one profile id" };
  }

  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "vpnProfileIds must be unique" };
  }

  return { ok: true };
}

function allVpnProfilesExist(db: Database, ids: number[]) {
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<{ id: number }, number[]>(
      `SELECT id
      FROM vpn_profiles
      WHERE id IN (${placeholders})`,
    )
    .all(...ids);

  return rows.length === ids.length;
}

function listChains(db: Database): ChainDto[] {
  const rows = db
    .query<ChainRow>(
      `SELECT
        c.id AS chain_id,
        c.name AS chain_name,
        h.vpn_profile_id AS vpn_profile_id
      FROM chains c
      LEFT JOIN chain_hops h ON h.chain_id = c.id
      ORDER BY c.id ASC, h.position ASC`,
    )
    .all();

  const chains = new Map<number, ChainDto>();
  for (const row of rows) {
    let chain = chains.get(row.chain_id);
    if (!chain) {
      chain = {
        id: row.chain_id,
        name: row.chain_name,
        vpnProfileIds: [],
      };
      chains.set(row.chain_id, chain);
    }

    if (row.vpn_profile_id !== null) {
      chain.vpnProfileIds.push(row.vpn_profile_id);
    }
  }

  return [...chains.values()];
}

function getChainById(db: Database, id: number): ChainDto | null {
  const rows = db
    .query<ChainRow, [number]>(
      `SELECT
        c.id AS chain_id,
        c.name AS chain_name,
        h.vpn_profile_id AS vpn_profile_id
      FROM chains c
      LEFT JOIN chain_hops h ON h.chain_id = c.id
      WHERE c.id = ?
      ORDER BY h.position ASC`,
    )
    .all(id);

  if (rows.length === 0) {
    return null;
  }

  return {
    id: rows[0].chain_id,
    name: rows[0].chain_name,
    vpnProfileIds: rows.flatMap((row) => (row.vpn_profile_id === null ? [] : [row.vpn_profile_id])),
  };
}

export function chainsRoutes(db: Database) {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json(listChains(db));
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    const parsed = validateCreateBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    const { name, vpnProfileIds } = parsed.value;
    if (!allVpnProfilesExist(db, vpnProfileIds)) {
      return c.json({ error: "vpnProfileIds must reference existing VPN profiles" }, 400);
    }

    let chainId = 0;

    db.exec("BEGIN");
    try {
      const chainResult = db.query("INSERT INTO chains (name) VALUES (?)").run(name);
      chainId = Number(chainResult.lastInsertRowid);

      for (const [position, vpnProfileId] of vpnProfileIds.entries()) {
        db.query(
          "INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)",
        ).run(chainId, position, vpnProfileId);
      }

      db.query(
        "INSERT INTO routing_profiles (name, chain_id, default_action) VALUES (?, ?, ?)",
      ).run(routingProfileName(name), chainId, "use_chain");

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json(getChainById(db, chainId)!, 201);
  });

  app.get("/:id/export", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid chain id" }, 400);
    }

    try {
      const exportJson = buildExportV1(db, id);
      return new Response(JSON.stringify(exportJson), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="vpn-manager.routing.v1.json"',
        },
      });
    } catch (error) {
      if (error instanceof ExportNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid chain id" }, 400);
    }

    const existing = getChainById(db, id);
    if (!existing) {
      return c.json({ error: "Chain not found" }, 404);
    }

    const body = await readJson(c);
    const parsed = validateUpdateBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    const nextName = parsed.value.name ?? existing.name;
    const nextVpnProfileIds = parsed.value.vpnProfileIds;

    if (nextVpnProfileIds && !allVpnProfilesExist(db, nextVpnProfileIds)) {
      return c.json({ error: "vpnProfileIds must reference existing VPN profiles" }, 400);
    }

    db.exec("BEGIN");
    try {
      if (parsed.value.name) {
        db.query("UPDATE chains SET name = ? WHERE id = ?").run(nextName, id);
        db.query("UPDATE routing_profiles SET name = ? WHERE chain_id = ?").run(
          routingProfileName(nextName),
          id,
        );
      }

      if (nextVpnProfileIds) {
        db.query("DELETE FROM chain_hops WHERE chain_id = ?").run(id);

        for (const [position, vpnProfileId] of nextVpnProfileIds.entries()) {
          db.query(
            "INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)",
          ).run(id, position, vpnProfileId);
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json(getChainById(db, id)!);
  });

  app.delete("/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid chain id" }, 400);
    }

    const existing = db.query("SELECT id FROM chains WHERE id = ?").get(id);
    if (!existing) {
      return c.json({ error: "Chain not found" }, 404);
    }

    db.query("DELETE FROM chains WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

  return app;
}
