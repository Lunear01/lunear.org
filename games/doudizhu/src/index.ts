// Public engine API for Fight the Landlord (Dou Dizhu). Pure rules, no I/O,
// no baked-in randomness — callers supply a shuffled deck (see shuffleDeck /
// createSeededRandom in ./cards). Imported only through the registry entry
// exported below; the platform never reaches into these modules directly.
export * from "./cards";
export * from "./deal";
export * from "./combos";
export * from "./game";

import { applyAction, createGame, settle, viewFor } from "./game";

export const engine = { createGame, applyAction, viewFor, settle };

export const gameDefinition = {
  id: "doudizhu",
  name: "Fight the Landlord",
  minSeats: 3,
  maxSeats: 3,
  engine,
  // Filled in by S6 (room Durable Object class) and S8 (table component).
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
