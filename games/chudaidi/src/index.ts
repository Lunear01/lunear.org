// Public engine API for Chu Dai D (Hong Kong Big Two). Pure rules, no I/O,
// no baked-in randomness — callers supply a shuffled deck (see shuffleDeck /
// createSeededRandom in ./cards). Imported only through the registry entry
// exported below; the platform never reaches into these modules directly.
export * from "./cards";
export * from "./deal";
export * from "./combos";
export * from "./game";
export * from "./suggest";

import { applyAction, createGame, settle, viewFor } from "./game";
import { suggestPlay } from "./suggest";

export const engine = { createGame, applyAction, viewFor, settle, suggestPlay };

export const gameDefinition = {
  id: "chudaidi",
  name: "Chu Dai D",
  // minSeats !== maxSeats routes quick play through LobbyDO's variable-seat path.
  minSeats: 2,
  maxSeats: 4,
  engine,
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
