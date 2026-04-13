import type { Database } from "bun:sqlite";
import { join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import "./types";
import { openDatabase } from "./db/client";
import type { Env } from "./env";
import { loadEnv } from "./env";
import { requireAuth } from "./middleware/auth";
import { authRoutes } from "./routes/auth";
import { chainsRoutes } from "./routes/chains";
import { profilesRoutes } from "./routes/profiles";
import { routingRoutes } from "./routes/routing";

// Dev note: set VPN_MANAGER_MASTER_KEY to the base64 of 32 random bytes before starting the server.
export function createApp(db: Database, env: Pick<Env, "masterKey" | "staticDir">) {
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

  const authed = new Hono();
  authed.use("*", requireAuth(db));
  authed.route("/profiles", profilesRoutes(db, env));
  authed.route("/chains", chainsRoutes(db));
  authed.route("/routing", routingRoutes(db));
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
  const app = createApp(db, env);
  serverState = { app, env };
  return serverState;
}

export default {
  get port() {
    return getServerState().env.port;
  },
  fetch(...args: Parameters<Hono["fetch"]>) {
    return getServerState().app.fetch(...args);
  },
};
