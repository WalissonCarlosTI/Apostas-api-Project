const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(
  process.env.DB_PATH || path.join(__dirname, "..", "data.db")
);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sport TEXT NOT NULL DEFAULT 'futebol'
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished','cancelled')),
  home_score INTEGER,
  away_score INTEGER
);
CREATE TABLE IF NOT EXISTS odds (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  selection TEXT NOT NULL CHECK (selection IN ('home','draw','away')),
  price REAL NOT NULL CHECK (price > 1),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, selection)
);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  stake_cents INTEGER NOT NULL CHECK (stake_cents > 0),
  total_odds REAL NOT NULL,
  potential_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','void')),
  payout_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE TABLE IF NOT EXISTS bet_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id INTEGER NOT NULL REFERENCES bets(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  selection TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  data TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs é imutável'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs é imutável'); END;
`);

module.exports = db;
