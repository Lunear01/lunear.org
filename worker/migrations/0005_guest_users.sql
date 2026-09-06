-- Migration number: 0005 	 2026-09-06T00:00:00.000Z

-- Guest accounts (S8b follow-up): ephemeral users created via
-- POST /api/auth/guest. Same users/credit_ledger/sessions machinery as a
-- real account — the "not saved" behavior lives entirely in how the client
-- holds the session token (in-memory only, no cookie), not in the schema.
ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1));
