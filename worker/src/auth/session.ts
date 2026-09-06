import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";

export const SESSION_COOKIE_NAME = "session_id";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthUser {
  id: string;
  username: string;
  credits: number;
  isAdmin: boolean;
}

export interface AuthVariables {
  user: AuthUser;
  sessionId: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 256-bit session id, hex-encoded (64 chars) — plain ASCII, safe as a cookie value.
export function generateSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; expiresAt: string }> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expiresAt)
    .run();
  return { id, expiresAt };
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

interface SessionRow {
  id: string;
  expires_at: string;
  user_id: string;
  username: string;
  credits: number;
  is_admin: number;
}

// Loads the session + owning user in one query; lazily deletes (and returns
// null for) an expired session rather than rejecting it up front.
export async function loadSessionUser(
  db: D1Database,
  sessionId: string,
): Promise<{ user: AuthUser; sessionId: string } | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.expires_at, u.id AS user_id, u.username, u.credits, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();
    return null;
  }

  return {
    sessionId: row.id,
    user: {
      id: row.user_id,
      username: row.username,
      credits: row.credits,
      isAdmin: row.is_admin === 1,
    },
  };
}

// Hono middleware: loads the session from the cookie, rejects with 401 when
// missing/invalid/expired, otherwise exposes `user` and `sessionId` via c.get().
// Reused as-is by S4 (admin) and S6 (room) routes.
export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionId) return c.json({ error: "unauthorized" }, 401);

  const loaded = await loadSessionUser(c.env.DB, sessionId);
  if (!loaded) {
    clearSessionCookie(c);
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", loaded.user);
  c.set("sessionId", loaded.sessionId);
  await next();
};
