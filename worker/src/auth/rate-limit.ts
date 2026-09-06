// Best-effort per-username login rate limiting (v1). Sliding 5-minute
// window tracked in D1 — no external infra, no per-IP tracking.
const WINDOW_MINUTES = 5;
const MAX_FAILURES = 10;

export async function isLoginLocked(
  db: D1Database,
  username: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_failures
       WHERE username = ? AND attempted_at > datetime('now', ?)`,
    )
    .bind(username, `-${WINDOW_MINUTES} minutes`)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordLoginFailure(
  db: D1Database,
  username: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO login_failures (username) VALUES (?)")
    .bind(username)
    .run();
}

export async function clearLoginFailures(
  db: D1Database,
  username: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM login_failures WHERE username = ?")
    .bind(username)
    .run();
}
