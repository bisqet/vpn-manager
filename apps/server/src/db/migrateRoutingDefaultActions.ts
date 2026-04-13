import type { Database } from "bun:sqlite";

const TERMINAL_USE_CHAIN_TO_DIRECT = `
UPDATE routing_profiles
SET default_action = 'direct'
WHERE default_action = 'use_chain'
  AND id IN (
    SELECT rp.id
    FROM routing_profiles rp
    JOIN chain_hops ch ON ch.id = rp.chain_hop_id
    JOIN (
      SELECT chain_id, MAX(position) AS max_pos
      FROM chain_hops
      GROUP BY chain_id
    ) t ON t.chain_id = ch.chain_id AND ch.position = t.max_pos
  );
`;

function routingProfilesTableSql(db: Database): string | null {
  const row = db
    .query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='routing_profiles'",
    )
    .get();
  return row?.sql ?? null;
}

export function migrateRoutingDefaultActionsIfNeeded(db: Database): void {
  const ddl = routingProfilesTableSql(db);
  if (ddl === null) {
    return;
  }

  const checkAlreadyWide = ddl.includes("('use_chain','direct','block')");

  if (!checkAlreadyWide) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(`CREATE TABLE routing_profiles__wide (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        chain_hop_id INTEGER NOT NULL REFERENCES chain_hops(id) ON DELETE CASCADE,
        default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct','block'))
      );`);
      db.exec(`INSERT INTO routing_profiles__wide (id, name, default_action, chain_hop_id)
        SELECT id, name, default_action, chain_hop_id FROM routing_profiles`);
      db.exec("DROP TABLE routing_profiles");
      db.exec("ALTER TABLE routing_profiles__wide RENAME TO routing_profiles");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS routing_profiles_chain_hop_id_key ON routing_profiles(chain_hop_id);",
      );
      db.exec(TERMINAL_USE_CHAIN_TO_DIRECT);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  } else {
    db.exec(TERMINAL_USE_CHAIN_TO_DIRECT);
  }
}
