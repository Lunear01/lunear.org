import { Hono } from "hono";
import { ensureAdminSeeded } from "../auth/admin-seed";
import {
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
} from "../auth/rate-limit";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  type AuthUser,
  type AuthVariables,
  clearSessionCookie,
  createSession,
  requireAuth,
  setSessionCookie,
} from "../auth/session";
import { isValidPassword, isValidUsername } from "../auth/validation";

export const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// One indexed SELECT per request once seeded; cheap enough to run on every
// auth route rather than special-casing login.
authRoutes.use("*", async (c, next) => {
  await ensureAdminSeeded(c.env);
  await next();
});

function serializeUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    credits: user.credits,
    is_admin: user.isAdmin,
  };
}

interface Credentials {
  username?: unknown;
  password?: unknown;
}

authRoutes.post("/register", async (c) => {
  const body = await c.req.json<Credentials>().catch(() => ({}) as Credentials);
  const { username, password } = body;

  if (!isValidUsername(username)) {
    return c.json(
      { error: "username must be 3-20 characters: letters, digits, underscore" },
      400,
    );
  }
  if (!isValidPassword(password)) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, credits, is_admin) VALUES (?, ?, ?, 0, 0)",
      ).bind(userId, username, passwordHash),
      c.env.DB.prepare(
        `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
         VALUES (?, 5000, NULL, 'signup_grant', ?)`,
      ).bind(userId, `signup:${userId}`),
      c.env.DB.prepare("UPDATE users SET credits = credits + 5000 WHERE id = ?").bind(
        userId,
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) {
      return c.json({ error: "username already taken" }, 409);
    }
    throw err;
  }

  const session = await createSession(c.env.DB, userId);
  setSessionCookie(c, session.id);

  return c.json(
    serializeUser({ id: userId, username, credits: 5000, isAdmin: false }),
    201,
  );
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<Credentials>().catch(() => ({}) as Credentials);
  const { username, password } = body;

  if (typeof username !== "string" || typeof password !== "string") {
    return c.json({ error: "username and password are required" }, 400);
  }

  const invalidCredentials = () =>
    c.json({ error: "invalid username or password" }, 401);

  if (await isLoginLocked(c.env.DB, username)) {
    return c.json(
      { error: "too many failed login attempts, try again later" },
      429,
    );
  }

  const row = await c.env.DB.prepare(
    "SELECT id, username, password_hash, credits, is_admin FROM users WHERE username = ?",
  )
    .bind(username)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      credits: number;
      is_admin: number;
    }>();

  // Same failure path (record + identical message) whether the user exists
  // or the password is wrong, so responses don't leak which one it was.
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await recordLoginFailure(c.env.DB, username);
    return invalidCredentials();
  }

  await clearLoginFailures(c.env.DB, username);
  const session = await createSession(c.env.DB, row.id);
  setSessionCookie(c, session.id);

  return c.json(
    serializeUser({
      id: row.id,
      username: row.username,
      credits: row.credits,
      isAdmin: row.is_admin === 1,
    }),
  );
});

authRoutes.post("/logout", requireAuth, async (c) => {
  const sessionId = c.get("sessionId");
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  return c.json(serializeUser(c.get("user")));
});
