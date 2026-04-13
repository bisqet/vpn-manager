import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import "./types";
import { openDatabase } from "./db/client";
import type { Env } from "./env";
import { loadEnv } from "./env";
import { requireAuth } from "./middleware/auth";
import { authRoutes } from "./routes/auth";
import { profilesRoutes } from "./routes/profiles";

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
  api.route("/", authed);

  app.route("/api", api);

  if (env.staticDir) {
    app.use("/*", serveStatic({ root: env.staticDir }));
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
