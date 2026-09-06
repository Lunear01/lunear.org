import { createDeck, type Card } from "../src/cards";
import type { Seat } from "../src/deal";

/** Full canonical deck indexed by id ("Q1", "K6", "A3", "JOKER1", ...). */
export const DECK_BY_ID: ReadonlyMap<string, Card> = new Map(createDeck().map((c) => [c.id, c]));

export function cardsOf(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = DECK_BY_ID.get(id);
    if (!card) throw new Error(`unknown test card id: ${id}`);
    return card;
  });
}

/** A valid 20-card deck order for tests that don't care about hand contents. */
export function anyValidDeck(): Card[] {
  return createDeck();
}

/**
 * Build a 20-card deal order from named per-seat id lists. dealHands reserves
 * a fixed 5-card block per seat (seat N -> deck positions [5N, 5N+5)), whether
 * or not that seat is alive this round — so each seat's list here places the
 * caller's chosen cards at the FRONT of that seat's block; any remaining slots
 * (and any seat omitted entirely) are filled with unused ids from the deck, so
 * every one of the 20 real cards is placed exactly once.
 */
export function buildRoundDeck(blocks: Partial<Record<Seat, readonly string[]>>): Card[] {
  const seats: readonly Seat[] = [0, 1, 2, 3];
  const usedInBlocks = new Set<string>();
  for (const seat of seats) {
    for (const id of blocks[seat] ?? []) {
      if (usedInBlocks.has(id)) throw new Error(`duplicate test card id: ${id}`);
      usedInBlocks.add(id);
    }
  }
  const filler = [...DECK_BY_ID.keys()].filter((id) => !usedInBlocks.has(id));
  let fillerCursor = 0;

  const order: string[] = new Array(20);
  for (const seat of seats) {
    const ids = blocks[seat] ?? [];
    if (ids.length > 5) throw new Error(`too many ids for seat ${seat}: ${ids.length}`);
    for (let i = 0; i < 5; i++) {
      order[seat * 5 + i] = ids[i] ?? filler[fillerCursor++];
    }
  }
  if (fillerCursor !== filler.length) {
    throw new Error(`buildRoundDeck internal error: used ${fillerCursor} of ${filler.length} filler ids`);
  }
  return cardsOf(order);
}

/** Bullet positions with every seat set to the same chamber value; override individual seats as needed. */
export function bulletPositions(
  value: number,
  overrides: Partial<Record<Seat, number>> = {},
): Record<Seat, number> {
  return {
    0: overrides[0] ?? value,
    1: overrides[1] ?? value,
    2: overrides[2] ?? value,
    3: overrides[3] ?? value,
  };
}
