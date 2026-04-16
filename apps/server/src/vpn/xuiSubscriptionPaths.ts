import { randomXuiAlnum } from "./xuiRandom";

const SEG_LEN = 18;

/** 3x-ui panel settings DB on Linux (see upstream `config.GetDBPath()`). */
export const XUI_PANEL_SETTINGS_DB = "/etc/x-ui/x-ui.db";

function stripSlashes(s: string): string {
  return s.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function toDbPath(segment: string): string {
  return `/${segment}/`;
}

/**
 * Random subscription paths for 3x-ui `settings` keys `subPath` and `subJsonPath`.
 * Avoids defaults `/sub/` and `/json/`, duplicate segments, and matching `webBasePath`.
 */
export function makeDistinctSubscriptionPathDbValues(webBasePath: string): {
  subPathDb: string;
  subJsonPathDb: string;
} {
  const wb = stripSlashes(webBasePath);
  for (let attempt = 0; attempt < 100; attempt++) {
    const seg1 = randomXuiAlnum(SEG_LEN);
    const seg2 = randomXuiAlnum(SEG_LEN);
    if (seg1 === seg2) continue;
    if (seg1 === wb || seg2 === wb) continue;
    if (seg1 === "sub" || seg2 === "sub" || seg1 === "json" || seg2 === "json") continue;
    const subPathDb = toDbPath(seg1);
    const subJsonPathDb = toDbPath(seg2);
    if (subPathDb === "/sub/" || subJsonPathDb === "/json/") continue;
    return { subPathDb, subJsonPathDb };
  }
  throw new Error("makeDistinctSubscriptionPathDbValues: exhausted retries");
}

/**
 * Remote bash fragment: persist `subPath` / `subJsonPath` in 3x-ui's SQLite (`settings` table).
 * Uses DELETE+INSERT so it works when keys are missing (fresh DB) or already present.
 * Values must be shell-safe (we only pass paths from {@link makeDistinctSubscriptionPathDbValues}).
 */
export function bashPersistSubscriptionPathsToSqlite(
  xuiDbPath: string,
  subPathDb: string,
  subJsonPathDb: string,
): string {
  return `XUI_DB='${xuiDbPath}'
test -f "$XUI_DB"
command -v sqlite3 >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sqlite3; }
sqlite3 "$XUI_DB" "BEGIN;
DELETE FROM settings WHERE key='subPath';
DELETE FROM settings WHERE key='subJsonPath';
INSERT INTO settings (key, value) VALUES ('subPath', '${subPathDb}');
INSERT INTO settings (key, value) VALUES ('subJsonPath', '${subJsonPathDb}');
COMMIT;"
sub_v=$(sqlite3 "$XUI_DB" "SELECT value FROM settings WHERE key='subPath';")
json_v=$(sqlite3 "$XUI_DB" "SELECT value FROM settings WHERE key='subJsonPath';")
test "$sub_v" = '${subPathDb}'
test "$json_v" = '${subJsonPathDb}'
`;
}
