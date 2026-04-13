import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

describe("migrate", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  test("creates users table", () => {
    migrate(db);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
    expect(rows.length).toBe(1);
  });
});
