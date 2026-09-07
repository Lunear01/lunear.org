import { gameDefinition as blackjack } from "blackjack";
import { gameDefinition as doudizhu } from "doudizhu";
import { gameDefinition as liarsbar } from "liarsbar";
import { gameDefinition as poker } from "poker";

// The one contract between the platform and a game package. `engine` is
// given a minimal structural shape (the four verbs every game room DO must
// be able to call) without importing any game's concrete state/action types
// here — the platform still never imports game rules, only this entry.
// `tableComponent` stays untyped until S8 gives it a real shape.
export interface GameEngine {
  createGame: (...args: never[]) => unknown;
  applyAction: (...args: never[]) => unknown;
  viewFor: (...args: never[]) => unknown;
  settle: (...args: never[]) => unknown;
}

export interface GameDefinition {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  engine?: GameEngine;
  /**
   * The room DO's class name, matching a durable_objects binding's
   * class_name in wrangler.jsonc (e.g. "GameTableDO" for the GAME_TABLE_DO
   * binding). v1 has exactly one game and one DO binding, so nothing yet
   * looks this up to resolve an env binding generically — S7 wires that if
   * a second game/binding ever needs it.
   */
  roomDurableObjectClass?: string;
  tableComponent?: unknown;
}

export const gameRegistry: readonly GameDefinition[] = [doudizhu, liarsbar, poker, blackjack];

export function getGameDefinition(id: string): GameDefinition | undefined {
  return gameRegistry.find((game) => game.id === id);
}
