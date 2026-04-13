import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../src/db/migrate";
import { hashPassword } from "../src/auth/password";

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
const databasePath = process.env.DATABASE_PATH ?? "data/vpn-manager.sqlite";

if (!username || !password) {
  console.error("ADMIN_USERNAME and ADMIN_PASSWORD are required");
  process.exit(1);
}

mkdirSync(dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.exec("PRAGMA foreign_keys = ON;");
migrate(db);

const existing = db.query("SELECT id FROM users WHERE username = ?").get(username);
if (existing) {
  console.error("User already exists");
  process.exit(1);
}

const hash = await hashPassword(password);
db.query("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
console.log("Admin user created");
