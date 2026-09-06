-- Migration number: 0003 	 2026-09-06T00:00:00.000Z

-- Free-text context for a ledger entry (currently only admin_adjustment
-- supplies one, e.g. "compensation for dropped game"). NULL elsewhere.
ALTER TABLE credit_ledger ADD COLUMN note TEXT;
