import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { assertValidCidr } from "../rules/cidr";
import { assertValidDomainRule, normalizeDomainSuffix } from "../rules/domain";

type DefaultAction = "use_chain" | "direct" | "block";
type MatchKind = "domain" | "cidr";
type RuleAction = "direct" | "use_chain" | "block";

type RoutingRuleDto = {
  id: number;
  position: number;
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

type RoutingProfileDto = {
  id: number;
  name: string;
  chainHopId: number;
  chainId: number;
  defaultAction: DefaultAction;
  rules: RoutingRuleDto[];
};

type RoutingProfileRow = {
  routing_profile_id: number;
  routing_profile_name: string;
  chain_hop_id: number;
  chain_id: number;
  default_action: DefaultAction;
  rule_id: number | null;
  rule_position: number | null;
  rule_match_kind: MatchKind | null;
  rule_match_value: string | null;
  rule_action: RuleAction | null;
};

type RoutingRuleInput = {
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

type RoutingPatchBody = {
  defaultAction: DefaultAction;
  rules: RoutingRuleInput[];
};

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

function isDefaultAction(value: unknown): value is DefaultAction {
  return value === "use_chain" || value === "direct" || value === "block";
}

function isTerminalRoutingProfile(db: Database, routingProfileId: number): boolean {
  const row = db
    .query<{ chain_id: number; position: number }, [number]>(
      `SELECT ch.chain_id AS chain_id, ch.position AS position
       FROM routing_profiles rp
       JOIN chain_hops ch ON ch.id = rp.chain_hop_id
       WHERE rp.id = ?`,
    )
    .get(routingProfileId);
  if (!row) {
    return false;
  }
  const maxRow = db
    .query<{ m: number | null }, [number]>(
      "SELECT MAX(position) AS m FROM chain_hops WHERE chain_id = ?",
    )
    .get(row.chain_id);
  const maxPos = maxRow?.m;
  return maxPos !== null && maxPos !== undefined && row.position === maxPos;
}

function isMatchKind(value: unknown): value is MatchKind {
  return value === "domain" || value === "cidr";
}

function isRuleAction(value: unknown): value is RuleAction {
  return value === "direct" || value === "use_chain" || value === "block";
}

function validatePatchBody(body: unknown):
  | { ok: true; value: RoutingPatchBody }
  | { ok: false; error: string } {
  if (!isRecord(body) || !isDefaultAction(body.defaultAction) || !Array.isArray(body.rules)) {
    return { ok: false, error: "Invalid routing payload" };
  }

  const rules: RoutingRuleInput[] = [];
  for (const rule of body.rules) {
    if (
      !isRecord(rule) ||
      !isMatchKind(rule.matchKind) ||
      typeof rule.matchValue !== "string" ||
      !isRuleAction(rule.action)
    ) {
      return { ok: false, error: "Invalid routing payload" };
    }

    rules.push({
      matchKind: rule.matchKind,
      matchValue: rule.matchValue,
      action: rule.action,
    });
  }

  return {
    ok: true,
    value: {
      defaultAction: body.defaultAction,
      rules,
    },
  };
}

function normalizeRule(rule: RoutingRuleInput): RoutingRuleInput {
  if (rule.matchKind === "domain") {
    const normalized = normalizeDomainSuffix(rule.matchValue);
    assertValidDomainRule(normalized);
    return {
      ...rule,
      matchValue: normalized,
    };
  }

  assertValidCidr(rule.matchValue);
  return rule;
}

function mapRoutingProfile(rows: RoutingProfileRow[]): RoutingProfileDto | null {
  if (rows.length === 0) {
    return null;
  }

  return {
    id: rows[0].routing_profile_id,
    name: rows[0].routing_profile_name,
    chainHopId: rows[0].chain_hop_id,
    chainId: rows[0].chain_id,
    defaultAction: rows[0].default_action,
    rules: rows.flatMap((row) => {
      if (
        row.rule_id === null ||
        row.rule_position === null ||
        row.rule_match_kind === null ||
        row.rule_match_value === null ||
        row.rule_action === null
      ) {
        return [];
      }

      return [
        {
          id: row.rule_id,
          position: row.rule_position,
          matchKind: row.rule_match_kind,
          matchValue: row.rule_match_value,
          action: row.rule_action,
        },
      ];
    }),
  };
}

const routingProfileSelectSql = `SELECT
        rp.id AS routing_profile_id,
        rp.name AS routing_profile_name,
        rp.chain_hop_id AS chain_hop_id,
        ch.chain_id AS chain_id,
        rp.default_action AS default_action,
        r.id AS rule_id,
        r.position AS rule_position,
        r.match_kind AS rule_match_kind,
        r.match_value AS rule_match_value,
        r.action AS rule_action
      FROM routing_profiles rp
      JOIN chain_hops ch ON ch.id = rp.chain_hop_id
      LEFT JOIN rules r ON r.routing_profile_id = rp.id`;

function getRoutingProfileByChainHopId(db: Database, chainHopId: number): RoutingProfileDto | null {
  const rows = db
    .query<RoutingProfileRow, [number]>(
      `${routingProfileSelectSql}
      WHERE rp.chain_hop_id = ?
      ORDER BY r.position ASC, r.id ASC`,
    )
    .all(chainHopId);

  return mapRoutingProfile(rows);
}

function getRoutingProfileById(db: Database, routingProfileId: number): RoutingProfileDto | null {
  const rows = db
    .query<RoutingProfileRow, [number]>(
      `${routingProfileSelectSql}
      WHERE rp.id = ?
      ORDER BY r.position ASC, r.id ASC`,
    )
    .all(routingProfileId);

  return mapRoutingProfile(rows);
}

export function routingRoutes(db: Database) {
  const app = new Hono();

  app.get("/by-hop/:chainHopId", (c) => {
    const chainHopId = parseId(c.req.param("chainHopId"));
    if (chainHopId === null) {
      return c.json({ error: "Invalid chain hop id" }, 400);
    }

    const routingProfile = getRoutingProfileByChainHopId(db, chainHopId);
    if (!routingProfile) {
      return c.json({ error: "Routing profile not found" }, 404);
    }

    return c.json(routingProfile);
  });

  app.patch("/:routingProfileId", async (c) => {
    const routingProfileId = parseId(c.req.param("routingProfileId"));
    if (routingProfileId === null) {
      return c.json({ error: "Invalid routing profile id" }, 400);
    }

    const existing = getRoutingProfileById(db, routingProfileId);
    if (!existing) {
      return c.json({ error: "Routing profile not found" }, 404);
    }

    const body = await readJson(c);
    const parsed = validatePatchBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    if (parsed.value.defaultAction === "use_chain" && isTerminalRoutingProfile(db, routingProfileId)) {
      return c.json(
        { error: "Terminal hop cannot use defaultAction use_chain; use direct or block." },
        400,
      );
    }

    let normalizedRules: RoutingRuleInput[];
    try {
      normalizedRules = parsed.value.rules.map(normalizeRule);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid routing payload" },
        400,
      );
    }

    db.exec("BEGIN");
    try {
      db.query("UPDATE routing_profiles SET default_action = ? WHERE id = ?").run(
        parsed.value.defaultAction,
        routingProfileId,
      );
      db.query("DELETE FROM rules WHERE routing_profile_id = ?").run(routingProfileId);

      for (const [position, rule] of normalizedRules.entries()) {
        db.query(
          "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
        ).run(routingProfileId, position, rule.matchKind, rule.matchValue, rule.action);
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json(getRoutingProfileById(db, routingProfileId)!);
  });

  return app;
}
