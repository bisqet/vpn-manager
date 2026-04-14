PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vpn_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL,
  ssh_user TEXT NOT NULL,
  ssh_password_ciphertext BLOB NOT NULL,
  ssh_password_nonce BLOB NOT NULL,
  operational_status TEXT NOT NULL DEFAULT 'pending' CHECK (operational_status IN ('pending','working')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_hops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  vpn_profile_id INTEGER NOT NULL REFERENCES vpn_profiles(id) ON DELETE RESTRICT,
  UNIQUE (chain_id, position),
  UNIQUE (chain_id, vpn_profile_id)
);

CREATE TABLE IF NOT EXISTS routing_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE,
  default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct','block'))
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routing_profile_id INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('domain','cidr')),
  match_value TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('direct','use_chain','block')),
  UNIQUE (routing_profile_id, position)
);
