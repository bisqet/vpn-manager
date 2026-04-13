import type { Database } from "bun:sqlite";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { SESSION_COOKIE } from "../auth/cookie";
import { getSessionUserId } from "../auth/session";

export function requireAuth(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);

    if (userId === null) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("userId", userId);
    await next();
  };
}
