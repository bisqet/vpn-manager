import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getAppSettings, patchAppSettings } from "../db/appSettings";

export function settingsRoutes(db: Database) {
  const app = new Hono();

  app.get("/", (c) => {
    const dto = getAppSettings(db);
    return c.json(dto);
  });

  app.patch("/", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const patch: {
      acmeEmail?: string;
      vpnSshEnabled?: boolean;
      sshKnownHostsFile?: string | null;
    } = {};
    if (typeof body.acmeEmail === "string") patch.acmeEmail = body.acmeEmail;
    if (typeof body.vpnSshEnabled === "boolean") patch.vpnSshEnabled = body.vpnSshEnabled;
    if (body.sshKnownHostsFile === null || typeof body.sshKnownHostsFile === "string") {
      patch.sshKnownHostsFile = body.sshKnownHostsFile as string | null;
    }
    const dto = patchAppSettings(db, patch);
    return c.json(dto);
  });

  return app;
}
