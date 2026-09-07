// Public engine API for no-limit Texas Hold'em. Pure rules, no I/O, no baked-in
// randomness — callers supply a shuffled deck (see shuffleDeck / createSeededRandom
// in ./cards). Imported only through the registry entry exported below; the
// platform never reaches into these modules directly.
export * from "./cards";
export * from "./deal";
export * from "./evaluator";
export * from "./game";

import { applyAction, createGame, settle, viewFor } from "./game";

export const engine = { createGame, applyAction, viewFor, settle };

export const gameDefinition = {
  id: "poker",
  name: "Poker",
  minSeats: 2,
  maxSeats: 8,
  engine,
  // Filled in by whichever steps add the room Durable Object class and table component.
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
