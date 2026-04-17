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

  test("vpn_profiles has operational_status", () => {
    migrate(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all();
    expect(cols.map((c) => c.name)).toContain("operational_status");
  });

  test("vpn_profiles has 3x-ui setup columns", () => {
    migrate(db);
    const names = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all().map((c) => c.name);
    expect(names).toContain("panel_hostname");
    expect(names).toContain("xui_secrets_ciphertext");
    expect(names).toContain("xui_secrets_nonce");
    expect(names).toContain("xui_web_base_path");
    expect(names).toContain("xui_panel_port");
    expect(names).toContain("last_setup_error");
    expect(names).toContain("last_setup_at");
  });

  test("vpn_profiles has panel reachability columns", () => {
    migrate(db);
    const names = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all().map((c) => c.name);
    expect(names).toContain("panel_reachability");
    expect(names).toContain("panel_reachability_detail");
    expect(names).toContain("panel_reachability_checked_at");
  });
});
