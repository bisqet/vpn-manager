import type { Database } from "bun:sqlite";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function createSession(db: Database, userId: number): { token: string; expiresAt: number } {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + WEEK_MS;
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($id, $uid, $exp)").run({
    $id: token,
    $uid: userId,
    $exp: expiresAt,
  });
  return { token, expiresAt };
}

export function getSessionUserId(db: Database, token: string | undefined): number | null {
  if (!token) return null;
  const row = db
    .query<{ user_id: number; expires_at: number }, [string]>(
      "SELECT user_id, expires_at FROM sessions WHERE id = ?",
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row.user_id;
}

export function deleteSession(db: Database, token: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(token);
}
