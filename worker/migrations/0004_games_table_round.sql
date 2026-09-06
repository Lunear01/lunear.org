-- Migration number: 0004 	 2026-09-06T00:00:00.000Z

-- S6 introduces rematches: one table (GameTableDO) can host multiple
-- finished game instances over its lifetime, so `games.id` alone (previously
-- assumed to equal the table id) is no longer a stable per-table key. `id`
-- becomes a synthetic `<tableId>:<round>` value; `table_id` + `round` keep a
-- table's game history queryable and make settlement idempotency keys
-- (`settle:<tableId>:<round>:<userId>`) traceable back to an archive row.
ALTER TABLE games ADD COLUMN table_id TEXT;
ALTER TABLE games ADD COLUMN round INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_games_table_id ON games(table_id);
