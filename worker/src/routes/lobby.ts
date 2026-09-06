import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthVariables } from "../auth/session";
import { requireAuth } from "../auth/session";
import { lobbyDoName } from "../durable-objects/lobby";
import { getGameDefinition } from "../registry";

// Lobby & matchmaking (S7), matching web/src/api/lobby.ts's LobbyApi seam.
// Response bodies are the LobbyApi return types verbatim (QuickPlayResult,
// CreateGameResult, OpenParty[], {tableId}) so S8b can implement LobbyApi
// with a straight `res.json()` per method.
//
// Quick-play polling contract (for S8b): POST .../quickplay is safe to call
// repeatedly. The first call from a user enqueues them and returns
// {status:"queued"} (or, if their join happened to complete a group,
// {status:"matched", tableId} immediately). A user already queued gets
// {status:"queued"} again on every re-call until some later caller's join
// fills the game's seat count, at which point every member of that group —
// including ones who called earlier and got "queued" — starts getting back
// {status:"matched", tableId} on their next call. So: poll on an interval
// while "queued"; stop once "matched". DELETE .../quickplay dequeues (a
// no-op if not queued, and does not affect a table already matched).
export const lobbyRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const MAX_STAKE = 10_000;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{1,16}$/;

lobbyRoutes.use("*", requireAuth);

/** Validates :gameId against the registry, writing a 404 response itself when unknown. */
function resolveGame(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
): string | Response {
  const gameId = c.req.param("gameId");
  if (!gameId || !getGameDefinition(gameId)) return c.json({ error: "unknown game" }, 404);
  return gameId;
}

function lobbyStub(c: Context<{ Bindings: Env; Variables: AuthVariables }>, gameId: string) {
  return c.env.LOBBY_DO.getByName(lobbyDoName(gameId));
}

lobbyRoutes.post("/:gameId/quickplay", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  const user = c.get("user");
  const result = await lobbyStub(c, gameId).quickPlay(gameId, user.id, user.username);
  return c.json(result);
});

lobbyRoutes.delete("/:gameId/quickplay", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  await lobbyStub(c, gameId).leaveQuickPlay(c.get("user").id);
  return c.json({ ok: true });
});

interface CreateGameBody {
  stake?: unknown;
  inviteOnly?: unknown;
}

lobbyRoutes.post("/:gameId/games", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  const body = await c.req.json<CreateGameBody>().catch(() => ({}) as CreateGameBody);
  const { stake, inviteOnly } = body;

  if (typeof stake !== "number" || !Number.isInteger(stake) || stake <= 0 || stake > MAX_STAKE) {
    return c.json({ error: `stake must be a positive integer up to ${MAX_STAKE}` }, 400);
  }
  if (typeof inviteOnly !== "boolean") {
    return c.json({ error: "inviteOnly must be a boolean" }, 400);
  }

  const user = c.get("user");
  // Built field-by-field (never a spread of `body`), matching routes/tables.ts's
  // convention — no client-supplied key reaches the DO beyond what's validated here.
  const result = await lobbyStub(c, gameId).createGame(gameId, {
    hostUserId: user.id,
    hostUsername: user.username,
    stake,
    inviteOnly,
  });
  return c.json(result);
});

lobbyRoutes.get("/:gameId/parties", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  const parties = await lobbyStub(c, gameId).listOpenParties();
  return c.json(parties);
});

lobbyRoutes.post("/:gameId/parties/:tableId/join", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  const tableId = c.req.param("tableId");
  if (!TABLE_ID_PATTERN.test(tableId)) return c.json({ error: "invalid table id" }, 400);

  const result = await lobbyStub(c, gameId).joinParty(tableId, c.get("user").id);
  if (!result.ok) {
    return result.reason === "full"
      ? c.json({ error: "party is full" }, 409)
      : c.json({ error: "party not found" }, 404);
  }
  return c.json({ tableId: result.tableId });
});

interface JoinByCodeBody {
  code?: unknown;
}

lobbyRoutes.post("/:gameId/join-by-code", async (c) => {
  const gameId = resolveGame(c);
  if (gameId instanceof Response) return gameId;

  const body = await c.req.json<JoinByCodeBody>().catch(() => ({}) as JoinByCodeBody);
  const code = body.code;
  if (typeof code !== "string" || !INVITE_CODE_PATTERN.test(code)) {
    return c.json({ error: "invalid invite code" }, 400);
  }

  const result = await lobbyStub(c, gameId).joinByCode(code.toUpperCase(), c.get("user").id);
  if (!result.ok) {
    return result.reason === "full"
      ? c.json({ error: "party is full" }, 409)
      : c.json({ error: "invalid invite code" }, 404);
  }
  return c.json({ tableId: result.tableId });
});
