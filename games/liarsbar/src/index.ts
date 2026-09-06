// Public engine API for Liar's Bar (Liar's Deck ruleset). Pure rules, no I/O,
// no baked-in randomness — callers supply a shuffled deck, table rank, and
// bullet chamber positions (see shuffleDeck / createSeededRandom / pickTableRank
// / rollBulletChamber in ./cards). Imported only through the registry entry
// exported below; the platform never reaches into these modules directly.
export * from "./cards";
export * from "./deal";
export * from "./game";

import { applyAction, createGame, settle, startNextRound, viewFor } from "./game";

export const engine = { createGame, applyAction, startNextRound, viewFor, settle };

export const gameDefinition = {
  id: "liarsbar",
  name: "Liar's Bar",
  minSeats: 4,
  maxSeats: 4,
  engine,
  // Filled in by whichever steps add the room Durable Object class and table component.
  roomDurableObjectClass: undefined,
  tableComponent: undefined,
} as const;
