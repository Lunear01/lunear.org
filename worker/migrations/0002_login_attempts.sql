-- Migration number: 0002 	 2026-09-06T00:00:00.000Z

-- Best-effort per-username login rate limiting (S3). A sliding 5-minute
-- window: >=10 rows for a username in the last 5 minutes locks that
-- username out. Rows are pruned/reset on successful login.
CREATE TABLE login_failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL COLLATE NOCASE,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_failures_username ON login_failures(username);
