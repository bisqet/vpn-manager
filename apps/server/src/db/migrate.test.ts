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

  test("routing_profiles uses chain_hop_id", () => {
    migrate(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(routing_profiles)").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("chain_hop_id");
    expect(names).not.toContain("chain_id");
  });
});
