import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

type LegacyProfileRow = {
  id: number;
  name: string;
  default_action: string;
  chain_id: number;
};

type HopRow = { id: number; position: number };

type RuleRow = {
  position: number;
  match_kind: string;
  match_value: string;
  action: string;
};

/**
 * SQLite rejects `ALTER TABLE ... DROP COLUMN` on `chain_id` while UNIQUE; rebuild removes it.
 * Caller must set `PRAGMA foreign_keys = OFF` before `DROP TABLE` so `rules` rows are not CASCADE-deleted.
 */
function rebuildRoutingProfilesWithoutChainId(db: Database): void {
  db.exec(`CREATE TABLE routing_profiles__migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct')),
    chain_hop_id INTEGER NOT NULL REFERENCES chain_hops(id) ON DELETE CASCADE
  );`);
  db.exec(`INSERT INTO routing_profiles__migrated (id, name, default_action, chain_hop_id)
    SELECT id, name, default_action, chain_hop_id FROM routing_profiles`);
  db.exec("DROP TABLE routing_profiles");
  db.exec("ALTER TABLE routing_profiles__migrated RENAME TO routing_profiles");
}

function routingProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(routing_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migratePerHopRoutingIfNeeded(db: Database): void {
  const cols = routingProfilesColumns(db);
  if (!cols.has("chain_id")) {
    return;
  }

  if (!cols.has("chain_hop_id")) {
    db.exec("ALTER TABLE routing_profiles ADD COLUMN chain_hop_id INTEGER REFERENCES chain_hops(id);");
  }

  const legacyProfiles = db
    .query<LegacyProfileRow, []>(
      "SELECT id, name, default_action, chain_id FROM routing_profiles WHERE chain_id IS NOT NULL",
    )
    .all();

  type MigrateWork = {
    profileId: number;
    name: string;
    default_action: string;
    hops: HopRow[];
    rules: RuleRow[];
  };

  const toDelete: number[] = [];
  const toMigrate: MigrateWork[] = [];

  for (const row of legacyProfiles) {
    const hops = db
      .query<HopRow, [number]>(
        "SELECT id, position FROM chain_hops WHERE chain_id = ? ORDER BY position ASC, id ASC",
      )
      .all(row.chain_id);

    const rules = db
      .query<RuleRow, [number]>(
        "SELECT position, match_kind, match_value, action FROM rules WHERE routing_profile_id = ? ORDER BY position ASC",
      )
      .all(row.id);

    if (hops.length === 0) {
      toDelete.push(row.id);
      continue;
    }

    toMigrate.push({
      profileId: row.id,
      name: row.name,
      default_action: row.default_action,
      hops,
      rules,
    });
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    for (const profileId of toDelete) {
      db.query("DELETE FROM rules WHERE routing_profile_id = ?").run(profileId);
      db.query("DELETE FROM routing_profiles WHERE id = ?").run(profileId);
    }

    for (const work of toMigrate) {
      db.query("UPDATE routing_profiles SET chain_hop_id = ? WHERE id = ?").run(work.hops[0]!.id, work.profileId);
    }

    const nullBeforeDrop = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM routing_profiles WHERE chain_hop_id IS NULL")
      .get();
    if (nullBeforeDrop && nullBeforeDrop.c > 0) {
      throw new Error("migratePerHopRoutingIfNeeded: routing_profiles.chain_hop_id is still NULL for some rows");
    }

    try {
      db.exec("ALTER TABLE routing_profiles DROP COLUMN chain_id;");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("cannot drop UNIQUE column")) {
        rebuildRoutingProfilesWithoutChainId(db);
      } else {
        throw e;
      }
    }

    for (const work of toMigrate) {
      for (let i = 1; i < work.hops.length; i++) {
        const hop = work.hops[i]!;
        const newProfileId = Number(
          db
            .query(
              "INSERT INTO routing_profiles (name, default_action, chain_hop_id) VALUES (?, ?, ?)",
            )
            .run(`${work.name} hop ${hop.position}`, work.default_action, hop.id).lastInsertRowid,
        );
        for (const rule of work.rules) {
          db
            .query(
              "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
            )
            .run(newProfileId, rule.position, rule.match_kind, rule.match_value, rule.action);
        }
      }
    }

    const nullHopsAfter = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM routing_profiles WHERE chain_hop_id IS NULL")
      .get();
    if (nullHopsAfter && nullHopsAfter.c > 0) {
      throw new Error("migratePerHopRoutingIfNeeded: routing_profiles.chain_hop_id is still NULL for some rows");
    }

    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS routing_profiles_chain_hop_id_key ON routing_profiles(chain_hop_id);");

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
