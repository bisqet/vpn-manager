import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import "./types";
import { openDatabase } from "./db/client";
import { loadEnv } from "./env";
import { authRoutes } from "./routes/auth";

// Dev note: set VPN_MANAGER_MASTER_KEY to the base64 of 32 random bytes before starting the server.
const env = loadEnv();
const db = openDatabase(env.databasePath);

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: true,
  }),
);

app.route("/api/auth", authRoutes(db));

if (env.staticDir) {
  app.use("/*", serveStatic({ root: env.staticDir }));
}

export default {
  port: env.port,
  fetch: app.fetch,
};
