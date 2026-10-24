-- Migration number: 0006 	 2026-10-24T00:00:00.000Z

-- Shop: card-back skins bought with credits. SQLite can't alter a CHECK, so
-- credit_ledger is rebuilt to add 'shop_purchase' to its reason list.
CREATE TABLE credit_ledger_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL,
  game_id         TEXT,
  reason          TEXT NOT NULL CHECK (reason IN ('signup_grant', 'game_settlement', 'admin_adjustment', 'shop_purchase')),
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  note            TEXT
);

INSERT INTO credit_ledger_new (id, user_id, amount, game_id, reason, idempotency_key, created_at, note)
  SELECT id, user_id, amount, game_id, reason, idempotency_key, created_at, note FROM credit_ledger;

DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_new RENAME TO credit_ledger;
CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id);

-- Owned shop items. 'classic' is implicit and never stored.
CREATE TABLE user_items (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);

-- Equipped card-back skin id; NULL = classic.
ALTER TABLE users ADD COLUMN card_skin TEXT;
