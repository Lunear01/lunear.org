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
  GUEST_SESSION_TTL_MS,
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
    is_guest: user.isGuest,
  };
}

const GUEST_STARTING_CREDITS = 5000;
const GUEST_USERNAME_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX_GUEST_USERNAME_ATTEMPTS = 5;

function randomGuestSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => GUEST_USERNAME_ALPHABET[b % GUEST_USERNAME_ALPHABET.length]).join(
    "",
  );
}

// Best-effort cleanup: guest accounts with no unexpired session are dead
// weight (the guest already lost access when their session expired, since
// the token lives only in the browser tab's memory). ON DELETE CASCADE on
// sessions/credit_ledger wipes their history along with the user row.
async function cleanupStaleGuests(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM users
         WHERE is_guest = 1
           AND id NOT IN (SELECT user_id FROM sessions WHERE expires_at > datetime('now'))`,
      )
      .run();
  } catch {
    // Never let opportunistic cleanup block guest creation.
  }
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
    serializeUser({ id: userId, username, credits: 5000, isAdmin: false, isGuest: false }),
    201,
  );
});

// Ephemeral account: 5000 credits, no password anyone can know, no cookie —
// the session token comes back in the body and the client is expected to
// hold it only in memory (see web/src/context/AuthContext.tsx), so a reload
// loses it by construction. Sessions are short-lived (24h) to bound how long
// an abandoned guest's row lingers before cleanupStaleGuests() reaps it.
authRoutes.post("/guest", async (c) => {
  await cleanupStaleGuests(c.env.DB);

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(crypto.randomUUID());

  let username = "";
  let created = false;
  for (let attempt = 0; attempt < MAX_GUEST_USERNAME_ATTEMPTS && !created; attempt++) {
    username = `Guest_${randomGuestSuffix()}`;
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO users (id, username, password_hash, credits, is_admin, is_guest) VALUES (?, ?, ?, 0, 0, 1)",
        ).bind(userId, username, passwordHash),
        c.env.DB.prepare(
          `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
           VALUES (?, ?, NULL, 'signup_grant', ?)`,
        ).bind(userId, GUEST_STARTING_CREDITS, `signup:${userId}`),
        c.env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").bind(
          GUEST_STARTING_CREDITS,
          userId,
        ),
      ]);
      created = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("UNIQUE")) throw err;
      // Username collision — loop and retry with a fresh random suffix.
    }
  }
  if (!created) {
    return c.json({ error: "could not allocate a guest account, try again" }, 500);
  }

  const session = await createSession(c.env.DB, userId, GUEST_SESSION_TTL_MS);

  // No setSessionCookie() call — this is the whole point of a guest: nothing
  // persists client-side that survives a reload.
  return c.json(
    {
      ...serializeUser({
        id: userId,
        username,
        credits: GUEST_STARTING_CREDITS,
        isAdmin: false,
        isGuest: true,
      }),
      token: session.id,
    },
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
    "SELECT id, username, password_hash, credits, is_admin, is_guest FROM users WHERE username = ?",
  )
    .bind(username)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      credits: number;
      is_admin: number;
      is_guest: number;
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
      isGuest: row.is_guest === 1,
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
