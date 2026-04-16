import type { Database } from "bun:sqlite";
import { join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { cors } from "hono/cors";
import "./types";
import { openDatabase } from "./db/client";
import type { Env } from "./env";
import { loadEnv } from "./env";
import { requireAuth } from "./middleware/auth";
import { authRoutes } from "./routes/auth";
import { chainsRoutes } from "./routes/chains";
import { importRoutes } from "./routes/import";
import { profilesRoutes, type ProfilesRoutesOptions } from "./routes/profiles";
import { routingRoutes } from "./routes/routing";
import { settingsRoutes } from "./routes/settings";

// Dev note: set VPN_MANAGER_MASTER_KEY to the base64 of 32 random bytes before starting the server.
export function createApp(
  db: Database,
  env: Pick<Env, "masterKey" | "staticDir">,
  options?: { profiles?: ProfilesRoutesOptions },
) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: true,
    }),
  );

  const api = new Hono();
  api.route("/auth", authRoutes(db));
  api.route(
    "/profiles",
    profilesRoutes(db, env, { upgradeWebSocket, ...options?.profiles }),
  );

  const authed = new Hono();
  authed.use("*", requireAuth(db));
  authed.route("/chains", chainsRoutes(db, { masterKey: env.masterKey }));
  authed.route("/routing", routingRoutes(db));
  authed.route("/import", importRoutes(db, env));
  authed.route("/settings", settingsRoutes(db));
  api.route("/", authed);

  app.route("/api", api);

  if (env.staticDir) {
    const staticDir = resolve(env.staticDir);
    const staticRoot = relative(process.cwd(), staticDir).replaceAll("\\", "/") || ".";

    app.use("/*", serveStatic({ root: staticRoot }));

    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api")) {
        return c.notFound();
      }

      const requestPath = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
      const assetFile = Bun.file(join(staticDir, requestPath));

      if (await assetFile.exists()) {
        return new Response(assetFile);
      }

      const acceptsHtml = (c.req.header("accept") ?? "").includes("text/html");
      if (!acceptsHtml) {
        return c.notFound();
      }

      const indexFile = Bun.file(join(staticDir, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile);
      }

      return c.notFound();
    });
  }

  return app;
}

let serverState: { app: Hono; env: Env } | null = null;

function getServerState() {
  if (serverState) {
    return serverState;
  }

  const env = loadEnv();
  const db = openDatabase(env.databasePath);
  const app = createApp(db, { masterKey: env.masterKey, staticDir: env.staticDir });
  serverState = { app, env };
  return serverState;
}

export default {
  get port() {
    return getServerState().env.port;
  },
  fetch(req: Request, server: unknown) {
    const { app } = getServerState();
    return app.fetch(req, { server } as { server: unknown });
  },
  websocket,
};
