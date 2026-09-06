import { lobbyDoName } from "../durable-objects/lobby";
import { gameRegistry } from "../registry";

// A user is "in a live game" if any game's LobbyDO has them recorded as a
// member of a table that's both unfinished and currently connected to (see
// LobbyDO.isLiveMember for the full definition, including its self-heal of
// stale membership left behind by a table abandoned mid-play). v1 has one
// registry entry, but this checks every game so it stays correct as more are
// added.
export async function isUserInLiveGame(env: Env, userId: string): Promise<boolean> {
  for (const game of gameRegistry) {
    const stub = env.LOBBY_DO.getByName(lobbyDoName(game.id));
    if (await stub.isLiveMember(userId)) return true;
  }
  return false;
}
