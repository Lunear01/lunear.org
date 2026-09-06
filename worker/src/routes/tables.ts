import { Hono } from "hono";
import type { AuthVariables } from "../auth/session";
import { extractSessionId, loadSessionUser, requireAuth } from "../auth/session";
import { getGameDefinition } from "../registry";

export const tableRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidTableId(id: string): boolean {
  return TABLE_ID_PATTERN.test(id);
}

interface InitBody {
  gameId?: unknown;
  stake?: unknown;
  visibility?: unknown;
  inviteCode?: unknown;
}

// Internal-ish table creation route. S7 (lobby & matchmaking) is expected to
// call GameTableDO.init(...) directly (it already holds a GAME_TABLE_DO
// binding) once it exists; this HTTP route exists so a table can be created
// before S7 lands, and may be replaced/removed by it.
tableRoutes.post("/:tableId/init", requireAuth, async (c) => {
  const tableId = c.req.param("tableId");
  if (!isValidTableId(tableId)) {
    return c.json({ error: "invalid table id" }, 400);
  }

  const body = await c.req.json<InitBody>().catch(() => ({}) as InitBody);
  const { gameId, stake, visibility, inviteCode } = body;

  if (typeof gameId !== "string" || !getGameDefinition(gameId)) {
    return c.json({ error: "unknown game" }, 400);
  }
  if (typeof stake !== "number" || !Number.isInteger(stake) || stake <= 0) {
    return c.json({ error: "stake must be a positive integer" }, 400);
  }
  if (visibility !== "public" && visibility !== "private") {
    return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
  }
  if (inviteCode !== undefined && typeof inviteCode !== "string") {
    return c.json({ error: "inviteCode must be a string" }, 400);
  }

  // Built field-by-field (never a spread of `body`) so no client-supplied key
  // — e.g. a test-only deck override — can ever reach the DO's init().
  const stub = c.env.GAME_TABLE_DO.getByName(tableId);
  const result = await stub.init({
    tableId,
    gameId,
    stake,
    visibility,
    inviteCode,
    hostUserId: c.get("user").id,
  });
  if (!result.ok) return c.json({ error: result.reason }, 400);
  return c.json({ ok: true, tableId });
});

// Not using the shared `requireAuth` middleware here: a browser's WebSocket
// API can't set custom headers on the upgrade request, so guests (who carry
// their session as a bearer token, never a cookie) need a `?token=` query
// param fallback that's specific to this route, not general HTTP auth.
tableRoutes.get("/:tableId/ws", async (c) => {
  const tableId = c.req.param("tableId");
  if (!isValidTableId(tableId)) {
    return c.json({ error: "invalid table id" }, 400);
  }
  const upgrade = c.req.header("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }

  const sessionId = extractSessionId(c) ?? c.req.query("token");
  if (!sessionId) return c.json({ error: "unauthorized" }, 401);
  const loaded = await loadSessionUser(c.env.DB, sessionId);
  if (!loaded) return c.json({ error: "unauthorized" }, 401);

  const user = loaded.user;
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-User-Id", user.id);
  headers.set("X-Username", user.username);
  const forwarded = new Request(c.req.raw, { headers });

  const stub = c.env.GAME_TABLE_DO.getByName(tableId);
  return stub.fetch(forwarded);
});
