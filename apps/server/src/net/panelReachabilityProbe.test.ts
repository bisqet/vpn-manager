import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildPanelProbeUrl,
  httpStatusMeansReachable,
  runPanelReachabilityProbe,
} from "./panelReachabilityProbe";

describe("httpStatusMeansReachable", () => {
  test("classifies statuses per spec", () => {
    expect(httpStatusMeansReachable(200)).toBe(true);
    expect(httpStatusMeansReachable(404)).toBe(false);
    expect(httpStatusMeansReachable(401)).toBe(true);
  });
});

describe("buildPanelProbeUrl", () => {
  test("uses root HTTPS URL when path and port are absent", () => {
    const url = buildPanelProbeUrl({
      panel_hostname: "203.0.113.1",
      xui_web_base_path: null,
      xui_panel_port: null,
    });
    expect(url).toBe("https://203.0.113.1/");
  });
});

describe("runPanelReachabilityProbe", () => {
  test("marks reachable on 401 from panel", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE vpn_profiles (
        id INTEGER PRIMARY KEY,
        panel_hostname TEXT NOT NULL,
        xui_web_base_path TEXT,
        xui_panel_port INTEGER,
        panel_reachability TEXT NOT NULL DEFAULT 'unknown',
        panel_reachability_detail TEXT,
        panel_reachability_checked_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.query(`INSERT INTO vpn_profiles (id, panel_hostname) VALUES (1, '203.0.113.1')`).run();

    const fetchFn = async () => new Response(null, { status: 401 });

    await runPanelReachabilityProbe({ db, profileId: 1, fetchFn });

    const row = db
      .query<{ panel_reachability: string }, [number]>(
        `SELECT panel_reachability FROM vpn_profiles WHERE id = ?`,
      )
      .get(1);
    expect(row?.panel_reachability).toBe("reachable");
  });
});
