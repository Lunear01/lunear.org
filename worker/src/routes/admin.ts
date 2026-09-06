import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuthVariables } from "../auth/session";
import { requireAuth } from "../auth/session";
import { isUserInLiveGame } from "../game/live-check";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  if (!c.get("user").isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

adminRoutes.use("*", requireAuth, requireAdmin);

interface UserRow {
  id: string;
  username: string;
  credits: number;
  is_admin: number;
  created_at: string;
}

function serializeUserRow(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    credits: row.credits,
    is_admin: row.is_admin === 1,
    created_at: row.created_at,
  };
}

// Clamps an untrusted query-string integer into [min, max], falling back to
// `fallback` when the input is missing or not a finite integer.
function clampIntParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

adminRoutes.get("/users", async (c) => {
  const limit = clampIntParam(
    c.req.query("limit"),
    DEFAULT_LIST_LIMIT,
    1,
    MAX_LIST_LIMIT,
  );
  const offset = clampIntParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // rowid (SQLite's implicit insertion-ordered key — users.id is a TEXT
  // primary key, not an alias for it) breaks created_at ties deterministically;
  // created_at alone only has second resolution.
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, credits, is_admin, created_at FROM users
     ORDER BY created_at DESC, rowid DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<UserRow>();

  return c.json({
    users: (results ?? []).map(serializeUserRow),
    limit,
    offset,
  });
});

interface CreditAdjustmentBody {
  amount?: unknown;
  reason?: unknown;
}

adminRoutes.post("/users/:id/credits", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req
    .json<CreditAdjustmentBody>()
    .catch(() => ({}) as CreditAdjustmentBody);
  const { amount, reason } = body;

  if (typeof amount !== "number" || !Number.isInteger(amount) || amount === 0) {
    return c.json({ error: "amount must be a non-zero integer" }, 400);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return c.json({ error: "reason is required" }, 400);
  }

  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(targetId)
    .first();
  if (!target) return c.json({ error: "user not found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key, note)
       VALUES (?, ?, NULL, 'admin_adjustment', NULL, ?)`,
    ).bind(targetId, amount, reason),
    c.env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(
      amount,
      targetId,
    ),
  ]);

  const updated = await c.env.DB.prepare("SELECT credits FROM users WHERE id = ?")
    .bind(targetId)
    .first<{ credits: number }>();

  return c.json({ id: targetId, credits: updated?.credits ?? null });
});

adminRoutes.delete("/users/:id", async (c) => {
  const targetId = c.req.param("id");
  const currentUser = c.get("user");

  if (targetId === currentUser.id) {
    return c.json({ error: "cannot delete your own account" }, 400);
  }

  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(targetId)
    .first();
  if (!target) return c.json({ error: "user not found" }, 404);

  if (await isUserInLiveGame(c.env, targetId)) {
    return c.json({ error: "cannot delete a user in a live game" }, 409);
  }

  // FK ON DELETE CASCADE (schema S2) removes the user's sessions and
  // credit_ledger rows.
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();

  return c.json({ ok: true });
});
