// Public engine API for blackjack (players vs. a house dealer). Pure rules,
// no I/O, no baked-in randomness — callers supply a shuffled shoe (see
// shuffleCards / createSeededRandom in ./cards). Imported only through the
// registry entry exported below; the platform never reaches into these
// modules directly.
export * from "./cards";
export * from "./game";

import { applyAction, createGame, settle, viewFor } from "./game";

export const engine = { createGame, applyAction, viewFor, settle };

export const gameDefinition = {
  id: "blackjack",
  name: "Blackjack",
  // minSeats 1: solo vs. the dealer is a real game, and minSeats !== maxSeats
  // routes quick play through LobbyDO's variable-seat join-or-create path.
  minSeats: 1,
  maxSeats: 5,
  engine,
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
