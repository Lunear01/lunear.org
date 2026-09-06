-- Migration number: 0001 	 2026-09-06T15:01:56.320Z

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 0, -- signed; negative balances are legal by design
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- Every balance change: signup grant, game settlement, admin adjustment.
-- SUM(amount) per user_id must always equal users.credits for that user.
CREATE TABLE credit_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL, -- signed; positive credits, negative debits
  game_id         TEXT,             -- e.g. 'doudizhu'; NULL for signup grants and admin adjustments
  reason          TEXT NOT NULL CHECK (reason IN ('signup_grant', 'game_settlement', 'admin_adjustment')),
  idempotency_key TEXT UNIQUE,      -- e.g. table id for a settlement, to prevent double-pay
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id);

-- Result archive, keyed by table id (one row per finished game instance).
CREATE TABLE games (
  id          TEXT PRIMARY KEY, -- table id
  game_id     TEXT NOT NULL,    -- e.g. 'doudizhu'
  stake       INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_games_game_id ON games(game_id);
