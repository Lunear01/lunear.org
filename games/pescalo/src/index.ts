// Public engine API for Pescalo (Go Fish). Pure rules, no I/O, no baked-in
// randomness — callers supply a shuffled deck (see shuffleDeck /
// createSeededRandom in ./cards). Imported only through the registry entry
// exported below; the platform never reaches into these modules directly.
export * from "./cards";
export * from "./game";

import { applyAction, createGame, settle, viewFor } from "./game";

export const engine = { createGame, applyAction, viewFor, settle };

export const gameDefinition = {
  id: "pescalo",
  name: "Pescalo",
  // minSeats !== maxSeats routes quick play through LobbyDO's variable-seat path.
  minSeats: 2,
  maxSeats: 5,
  engine,
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
