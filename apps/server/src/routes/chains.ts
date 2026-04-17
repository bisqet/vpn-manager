import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { decryptXuiSecretsJson } from "../crypto/xuiSecrets";
import type { Env } from "../env";
import { buildExportV2, ExportNotFoundError } from "../export/buildExport";
import { buildPanelHttpsUrl } from "../net/panelAddress";
import { buildVlessRealityInboundBody } from "../xui/buildVlessRealityInboundBody";
import { generateRealityClientMaterial } from "../xui/realityKeyMaterial";
import { provisionChainClientAccess } from "../xui/provisionChainClientAccess";

type ChainListRow = {
  chain_id: number;
  chain_name: string;
  hop_id: number | null;
  hop_position: number | null;
  vpn_profile_id: number | null;
  vpn_label: string | null;
};

type ChainHopDto = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

type ChainDto = {
  id: number;
  name: string;
  vpnProfileIds: number[];
  hops: ChainHopDto[];
};

type ChainCreateBody = {
  name: string;
  vpnProfileIds: number[];
};

type ChainUpdateBody = {
  name?: string;
  vpnProfileIds?: number[];
};

function routingProfileNameForHop(chainName: string, position: number) {
  return `${chainName} hop ${position}`;
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

function chainDtoFromRows(rows: ChainListRow[]): ChainDto | null {
  if (rows.length === 0) {
    return null;
  }

  const hops: ChainHopDto[] = [];
  const vpnProfileIds: number[] = [];

  for (const row of rows) {
    if (
      row.hop_id === null ||
      row.hop_position === null ||
      row.vpn_profile_id === null ||
      row.vpn_label === null
    ) {
      continue;
    }

    hops.push({
      id: row.hop_id,
      position: row.hop_position,
      vpnProfileId: row.vpn_profile_id,
      label: row.vpn_label,
    });
    vpnProfileIds.push(row.vpn_profile_id);
  }

  return {
    id: rows[0].chain_id,
    name: rows[0].chain_name,
    vpnProfileIds,
    hops,
  };
}

function listChains(db: Database): ChainDto[] {
  const rows = db
    .query<ChainListRow>(
      `SELECT
        c.id AS chain_id,
        c.name AS chain_name,
        h.id AS hop_id,
        h.position AS hop_position,
        h.vpn_profile_id AS vpn_profile_id,
        vp.label AS vpn_label
      FROM chains c
      LEFT JOIN chain_hops h ON h.chain_id = c.id
      LEFT JOIN vpn_profiles vp ON vp.id = h.vpn_profile_id
      ORDER BY c.id ASC, h.position ASC, h.id ASC`,
    )
    .all();

  const chains = new Map<number, ChainListRow[]>();
  for (const row of rows) {
    let bucket = chains.get(row.chain_id);
    if (!bucket) {
      bucket = [];
      chains.set(row.chain_id, bucket);
    }
    bucket.push(row);
  }

  return [...chains.values()].flatMap((group) => {
    const dto = chainDtoFromRows(group);
    return dto ? [dto] : [];
  });
}

function getChainById(db: Database, id: number): ChainDto | null {
  const rows = db
    .query<ChainListRow, [number]>(
      `SELECT
        c.id AS chain_id,
        c.name AS chain_name,
        h.id AS hop_id,
        h.position AS hop_position,
        h.vpn_profile_id AS vpn_profile_id,
        vp.label AS vpn_label
      FROM chains c
      LEFT JOIN chain_hops h ON h.chain_id = c.id
      LEFT JOIN vpn_profiles vp ON vp.id = h.vpn_profile_id
      WHERE c.id = ?
      ORDER BY h.position ASC, h.id ASC`,
    )
    .all(id);

  return chainDtoFromRows(rows);
}

function insertRoutingProfilesForHops(db: Database, chainId: number, chainName: string, hopCount: number) {
  for (let position = 0; position < hopCount; position++) {
    const hopRow = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM chain_hops WHERE chain_id = ? AND position = ?",
      )
      .get(chainId, position);
    if (!hopRow) {
      throw new Error("Expected chain_hops row after insert");
    }
    const isTerminalHop = position === hopCount - 1;
    const defaultAction = isTerminalHop ? "direct" : "use_chain";
    db.query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)").run(
      routingProfileNameForHop(chainName, position),
      hopRow.id,
      defaultAction,
    );
  }
}

export function chainsRoutes(db: Database, env: Pick<Env, "masterKey">) {
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

      insertRoutingProfilesForHops(db, chainId, name, vpnProfileIds.length);

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
      const exportJson = buildExportV2(db, id);
      return new Response(JSON.stringify(exportJson), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="vpn-manager.routing.v2.json"',
        },
      });
    } catch (error) {
      if (error instanceof ExportNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/:id/generate-profile", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid chain id" }, 400);
    }

    const chain = getChainById(db, id);
    if (!chain) {
      return c.json({ error: "Chain not found" }, 404);
    }

    if (chain.hops.length !== 1) {
      return c.json({ error: "Generate profile requires a single-hop chain." }, 400);
    }

    const hop = chain.hops[0]!;
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
        .get(hop.vpnProfileId) ?? null;

    if (
      !row ||
      row.operational_status !== "working" ||
      !row.xui_secrets_ciphertext ||
      !row.xui_secrets_nonce
    ) {
      return c.json({ error: "VPN profile must be working with stored panel credentials." }, 409);
    }

    let secrets;
    try {
      secrets = await decryptXuiSecretsJson(env.masterKey, row.xui_secrets_ciphertext, row.xui_secrets_nonce);
    } catch {
      return c.json({ error: "VPN profile must be working with stored panel credentials." }, 409);
    }

    if (secrets.v !== 1) {
      return c.json({ error: "VPN profile must be working with stored panel credentials." }, 409);
    }

    const panelPort = row.xui_panel_port == null ? null : Number(row.xui_panel_port);
    const panelUrl = buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path, panelPort);
    if (!panelUrl) {
      return c.json({ error: "Panel URL is not available for this profile." }, 409);
    }

    const material = await generateRealityClientMaterial();
    const inboundBody = buildVlessRealityInboundBody({
      port: 443,
      remark: `chain-${id}-${Date.now()}`,
      clientEmail: `vpnmgr-${material.clientUuid}@chain-${id}.local`,
      clientUuid: material.clientUuid,
      subId: material.subId,
      shortId: material.shortId,
      realityPrivateKeyB64: material.realityPrivateKeyB64,
      realityPublicKeyB64: material.realityPublicKeyB64,
    });

    try {
      const result = await provisionChainClientAccess({
        panelBaseUrl: panelUrl,
        adminUsername: secrets.adminUsername,
        adminPassword: secrets.adminPassword,
        inboundBody: inboundBody as unknown as Record<string, unknown>,
        fetchFn: globalThis.fetch,
      });
      return c.json(result);
    } catch {
      // Do not forward panel or transport exception text to the client (avoid leaking internals).
      return c.json({ error: "Panel request failed." }, 502);
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
      }

      if (nextVpnProfileIds) {
        db.query("DELETE FROM chain_hops WHERE chain_id = ?").run(id);

        for (const [position, vpnProfileId] of nextVpnProfileIds.entries()) {
          db.query(
            "INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)",
          ).run(id, position, vpnProfileId);
        }

        insertRoutingProfilesForHops(db, id, nextName, nextVpnProfileIds.length);
      } else if (parsed.value.name) {
        const profiles = db
          .query<{ id: number; position: number }, [number]>(
            `SELECT rp.id, ch.position
             FROM routing_profiles rp
             JOIN chain_hops ch ON ch.id = rp.chain_hop_id
             WHERE ch.chain_id = ?
             ORDER BY ch.position ASC`,
          )
          .all(id);
        for (const row of profiles) {
          db.query("UPDATE routing_profiles SET name = ? WHERE id = ?").run(
            routingProfileNameForHop(nextName, row.position),
            row.id,
          );
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
