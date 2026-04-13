import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../auth/cookie";
import { verifyPassword } from "../auth/password";
import { createSession, deleteSession, getSessionUserId } from "../auth/session";

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
};

type MeRow = {
  id: number;
  username: string;
};

const INVALID_CREDENTIALS = "Invalid username or password";

export function authRoutes(db: Database) {
  const app = new Hono();

  app.post("/login", async (c) => {
    let body: { username?: unknown; password?: unknown };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: INVALID_CREDENTIALS }, 401);
    }

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    const user = db
      .query<UserRow, [string]>("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get(username);

    const isValid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !isValid) {
      return c.json({ error: INVALID_CREDENTIALS }, 401);
    }

    const { token, expiresAt } = createSession(db, user.id);
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    });

    return c.json({ user: { id: user.id, username: user.username } });
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      deleteSession(db, token);
    }

    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/me", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);
    if (userId === null) {
      return c.json({ user: null });
    }

    const user = db.query<MeRow, [number]>("SELECT id, username FROM users WHERE id = ?").get(userId);
    if (!user) {
      return c.json({ user: null });
    }

    return c.json({ user });
  });

  return app;
}
