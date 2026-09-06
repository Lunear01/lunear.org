import { hashPassword } from "./password";

const ADMIN_USERNAME = "admin";
const ADMIN_STARTING_CREDITS = 5000;

// Idempotent: seeds the single admin account (username `admin`) the first
// time it's called. Cheap once seeded — one indexed SELECT, no writes.
// Skips silently when ADMIN_PASSWORD isn't configured (e.g. dev/test envs
// that don't need an admin) rather than failing requests.
export async function ensureAdminSeeded(env: Env): Promise<void> {
  if (!env.ADMIN_PASSWORD) return;

  const existing = await env.DB.prepare(
    "SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1",
  ).first();
  if (existing) return;

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, credits, is_admin) VALUES (?, ?, ?, 0, 1)",
      ).bind(userId, ADMIN_USERNAME, passwordHash),
      env.DB.prepare(
        `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
         VALUES (?, ?, NULL, 'signup_grant', ?)`,
      ).bind(userId, ADMIN_STARTING_CREDITS, `signup:${userId}`),
      env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(
        ADMIN_STARTING_CREDITS,
        userId,
      ),
    ]);
  } catch (err) {
    // Two concurrent requests can both pass the "no admin yet" check; the
    // loser hits the UNIQUE username constraint. Safe to ignore — the
    // invariant (exactly one admin) still holds.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("UNIQUE")) throw err;
  }
}
