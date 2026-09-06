import { createDeck, type Card } from "../src/cards";

/** Full canonical deck indexed by id ("3S", "10H", "BJ", "RJ", ...). */
export const DECK_BY_ID: ReadonlyMap<string, Card> = new Map(createDeck().map((c) => [c.id, c]));

export function cardsOf(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = DECK_BY_ID.get(id);
    if (!card) throw new Error(`unknown test card id: ${id}`);
    return card;
  });
}

/**
 * Build a 54-card deal order from named id groups (e.g. seat0, seat1, seat2,
 * landlordCards), asserting every real card is used exactly once. Throws
 * immediately on a typo instead of silently producing a bad fixture.
 */
/** A valid 54-card deal order for tests that don't care about hand contents. */
export function anyValidDeck(): Card[] {
  return createDeck();
}

export function buildDealOrder(groups: {
  seat0: readonly string[];
  seat1: readonly string[];
  seat2: readonly string[];
  landlordCards: readonly string[];
}): Card[] {
  const order = [...groups.seat0, ...groups.seat1, ...groups.seat2, ...groups.landlordCards];
  if (order.length !== 54) {
    throw new Error(`buildDealOrder expected 54 ids, got ${order.length}`);
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) throw new Error(`duplicate test card id: ${id}`);
    seen.add(id);
  }
  if (seen.size !== DECK_BY_ID.size) {
    const missing = [...DECK_BY_ID.keys()].filter((id) => !seen.has(id));
    throw new Error(`buildDealOrder missing ids: ${missing.join(", ")}`);
  }
  return cardsOf(order);
}
