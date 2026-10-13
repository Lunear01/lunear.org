import { createDeck, type Card } from "../src/cards";
import type { Seat } from "../src/deal";
import { applyAction, type Action, type GameState, type RejectionReason } from "../src/game";

/** Full canonical deck indexed by id ("3D", "10S", "2S", ...). */
export const DECK_BY_ID: ReadonlyMap<string, Card> = new Map(createDeck().map((c) => [c.id, c]));

export function cardsOf(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = DECK_BY_ID.get(id);
    if (!card) throw new Error(`unknown test card id: ${id}`);
    return card;
  });
}

/**
 * Build a 52-card deal order from per-seat 13-card blocks. Seats left out
 * are filled with the remaining cards in deck order, so a 2- or 3-seat
 * fixture only names the hands it cares about.
 */
export function buildDealOrder(blocks: Partial<Record<Seat, readonly string[]>>): Card[] {
  const named = new Set<string>();
  for (const seat of [0, 1, 2, 3] as const) {
    const ids = blocks[seat];
    if (!ids) continue;
    if (ids.length !== 13) throw new Error(`seat ${seat} block must hold 13 ids, got ${ids.length}`);
    for (const id of ids) {
      if (named.has(id)) throw new Error(`duplicate test card id: ${id}`);
      if (!DECK_BY_ID.has(id)) throw new Error(`unknown test card id: ${id}`);
      named.add(id);
    }
  }
  const filler = createDeck().filter((c) => !named.has(c.id));
  const order: Card[] = [];
  for (const seat of [0, 1, 2, 3] as const) {
    const ids = blocks[seat];
    if (ids) order.push(...cardsOf(ids));
    else order.push(...filler.splice(0, 13));
  }
  return order;
}

/** Apply an action that must succeed; throws with the rejection reason otherwise. */
export function act(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  return result.state;
}

export function expectRejected(state: GameState, seat: Seat, action: Action, reason: RejectionReason): void {
  const result = applyAction(state, seat, action);
  if (result.ok) throw new Error(`expected rejection ${reason}, but action succeeded`);
  if (result.reason !== reason) throw new Error(`expected rejection ${reason}, got ${result.reason}`);
}

export function play(state: GameState, seat: Seat, ids: readonly string[]): GameState {
  return act(state, seat, { type: "play", cardIds: ids });
}

export function pass(state: GameState, seat: Seat): GameState {
  return act(state, seat, { type: "pass" });
}
