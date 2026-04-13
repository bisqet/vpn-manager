import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { assertValidCidr } from "../rules/cidr";
import { assertValidDomainRule, normalizeDomainSuffix } from "../rules/domain";

type DefaultAction = "use_chain" | "direct";
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
  chainId: number;
  defaultAction: DefaultAction;
  rules: RoutingRuleDto[];
};

type RoutingProfileRow = {
  routing_profile_id: number;
  routing_profile_name: string;
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
  return value === "use_chain" || value === "direct";
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

function getRoutingProfileByChainId(db: Database, chainId: number): RoutingProfileDto | null {
  const rows = db
    .query<RoutingProfileRow, [number]>(
      `SELECT
        rp.id AS routing_profile_id,
        rp.name AS routing_profile_name,
        rp.chain_id AS chain_id,
        rp.default_action AS default_action,
        r.id AS rule_id,
        r.position AS rule_position,
        r.match_kind AS rule_match_kind,
        r.match_value AS rule_match_value,
        r.action AS rule_action
      FROM routing_profiles rp
      LEFT JOIN rules r ON r.routing_profile_id = rp.id
      WHERE rp.chain_id = ?
      ORDER BY r.position ASC, r.id ASC`,
    )
    .all(chainId);

  return mapRoutingProfile(rows);
}

function getRoutingProfileById(db: Database, routingProfileId: number): RoutingProfileDto | null {
  const rows = db
    .query<RoutingProfileRow, [number]>(
      `SELECT
        rp.id AS routing_profile_id,
        rp.name AS routing_profile_name,
        rp.chain_id AS chain_id,
        rp.default_action AS default_action,
        r.id AS rule_id,
        r.position AS rule_position,
        r.match_kind AS rule_match_kind,
        r.match_value AS rule_match_value,
        r.action AS rule_action
      FROM routing_profiles rp
      LEFT JOIN rules r ON r.routing_profile_id = rp.id
      WHERE rp.id = ?
      ORDER BY r.position ASC, r.id ASC`,
    )
    .all(routingProfileId);

  return mapRoutingProfile(rows);
}

export function routingRoutes(db: Database) {
  const app = new Hono();

  app.get("/by-chain/:chainId", (c) => {
    const chainId = parseId(c.req.param("chainId"));
    if (chainId === null) {
      return c.json({ error: "Invalid chain id" }, 400);
    }

    const routingProfile = getRoutingProfileByChainId(db, chainId);
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
