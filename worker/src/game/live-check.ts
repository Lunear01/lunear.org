import { lobbyDoName } from "../durable-objects/lobby";
import { gameRegistry } from "../registry";

// Wired for real by S7: a user is "in a live game" if any game's LobbyDO
// still has them recorded as an active member (membership is set when a
// table is created/joined/matched through the lobby and cleared once that
// table's hand settles — see LobbyDO.notifySettled). v1 has one registry
// entry, but this checks every game so it stays correct as more are added.
export async function isUserInLiveGame(env: Env, userId: string): Promise<boolean> {
  for (const game of gameRegistry) {
    const stub = env.LOBBY_DO.getByName(lobbyDoName(game.id));
    if (await stub.isMember(userId)) return true;
  }
  return false;
}
