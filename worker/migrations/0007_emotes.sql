-- Migration number: 0007 	 2026-10-24T00:00:00.000Z

-- Consumable emote stock. Bought through the shop (credit_ledger reason
-- 'shop_purchase'), decremented by a table DO each time one is used.
CREATE TABLE user_emotes (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emote_id TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (user_id, emote_id)
);
