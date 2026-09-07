import { createDeck, type Card } from "../src/cards";
import type { Seat } from "../src/deal";
import { applyAction, type Action, type GameState } from "../src/game";

/** Full canonical deck indexed by id ("As", "Th", "2c", ...). */
export const DECK_BY_ID: ReadonlyMap<string, Card> = new Map(createDeck().map((c) => [c.id, c]));

export function cardsOf(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = DECK_BY_ID.get(id);
    if (!card) throw new Error(`unknown test card id: ${id}`);
    return card;
  });
}

/** A valid 52-card deck order for tests that don't care about hole/board contents. */
export function anyValidDeck(): Card[] {
  return createDeck();
}

/**
 * Build a full 52-card deal order from named hole-card pairs and an optional community
 * sequence, with every remaining card filled in afterward from the unused pool.
 *
 * Mirrors dealHoleCards' actual dealing convention exactly: seat i, by ASCENDING seat-number
 * position (not raw seat number), gets deck slots [2i, 2i+2) — so `hole` keys must be real seat
 * numbers from `seats`, placed according to where each seat sorts. Community cards are dealt
 * straight off the remainder of the deck afterward, flop(3)/turn(1)/river(1) in order, no burns —
 * so `community` here is exactly that 5-card sequence (or a prefix of it, for tests that only
 * need e.g. the flop to be fixed and don't care what the turn/river turn out to be).
 */
export function buildDeck(
  seats: readonly Seat[],
  opts: { readonly hole?: Partial<Record<Seat, readonly [string, string]>>; readonly community?: readonly string[] },
): Card[] {
  const sorted = seats.slice().sort((a, b) => a - b);
  const used = new Set<string>();
  const addUsed = (id: string): void => {
    if (used.has(id)) throw new Error(`duplicate test card id: ${id}`);
    used.add(id);
  };

  const holeBlock: (string | undefined)[] = new Array(sorted.length * 2).fill(undefined);
  sorted.forEach((seat, i) => {
    const pair = opts.hole?.[seat];
    if (!pair) return;
    addUsed(pair[0]);
    addUsed(pair[1]);
    holeBlock[i * 2] = pair[0];
    holeBlock[i * 2 + 1] = pair[1];
  });

  const communityIds = opts.community ?? [];
  for (const id of communityIds) addUsed(id);

  const filler = [...DECK_BY_ID.keys()].filter((id) => !used.has(id));
  let fillerCursor = 0;
  const holeIds = holeBlock.map((id) => id ?? filler[fillerCursor++]);

  const order = [...holeIds, ...communityIds];
  while (order.length < 52) order.push(filler[fillerCursor++]);
  if (order.length !== 52) throw new Error(`buildDeck internal error: built ${order.length} cards, expected 52`);

  return cardsOf(order);
}

/** Apply an action, throwing with the rejection reason if it's unexpectedly refused. */
export function act(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    throw new Error(`applyAction rejected: ${result.reason} (seat ${seat}, ${JSON.stringify(action)})`);
  }
  return result.state;
}

/** Apply an action and assert it was rejected with the given reason. */
export function expectRejected(state: GameState, seat: Seat, action: Action, reason: string): void {
  const result = applyAction(state, seat, action);
  if (result.ok) throw new Error(`expected rejection "${reason}" but action succeeded`);
  if (result.reason !== reason) throw new Error(`expected rejection "${reason}" but got "${result.reason}"`);
}
