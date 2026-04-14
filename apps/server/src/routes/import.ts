import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Env } from "../env";
import { applyImport } from "../import/applyImport";
import { buildImportPlan } from "../import/buildImportPlan";
import { parseImportDocument } from "../import/parseImportDocument";

export function importRoutes(db: Database, env: Pick<Env, "masterKey">) {
  const app = new Hono();

  app.post("/preview", async (c) => {
    const raw = await c.req.text();

    const parsed = parseImportDocument(raw);
    if (!parsed.ok) {
      return c.json({ error: "Invalid import JSON", details: parsed.errors }, 400);
    }

    const planResult = buildImportPlan(db, parsed.normalized);
    return c.json({
      canApply: planResult.canApply,
      plan: planResult.plan,
      warnings: planResult.warnings,
      errors: planResult.errors,
      passwordKeys: planResult.passwordKeys,
      panelHostnameKeys: planResult.panelHostnameKeys,
    });
  });

  app.post("/apply", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }

    const b = body as Record<string, unknown>;

    if (!b.import || typeof b.import !== "object" || Array.isArray(b.import)) {
      return c.json({ error: "Missing or invalid 'import' field" }, 400);
    }

    const passwords =
      b.passwords && typeof b.passwords === "object" && !Array.isArray(b.passwords)
        ? (b.passwords as Record<string, string>)
        : {};

    const panelHostnames =
      b.panelHostnames && typeof b.panelHostnames === "object" && !Array.isArray(b.panelHostnames)
        ? (b.panelHostnames as Record<string, string>)
        : {};

    const raw = JSON.stringify(b.import);
    const parsed = parseImportDocument(raw);
    if (!parsed.ok) {
      return c.json({ error: "Invalid import JSON", details: parsed.errors }, 400);
    }

    const result = await applyImport({
      db,
      env,
      normalized: parsed.normalized,
      passwords,
      panelHostnames,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.status ?? 400);
    }

    return c.json({
      chainIds: result.chainIds,
      profileIds: result.profileIds,
    });
  });

  return app;
}
