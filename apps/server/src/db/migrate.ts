import type { Database } from "bun:sqlite";
import schema from "./schema.sql" with { type: "text" };

export function migrate(db: Database): void {
  db.exec(schema);
}
