import { createDeck, type Card } from "../src/cards";
import {
  applyAction,
  createGame,
  handSizeFor,
  type Action,
  type GameState,
  type RejectionReason,
  type Seat,
} from "../src/game";

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
 * Build a 52-card deal order: named hands in `activeSeats` order, then the
 * named pool top-first, then every unnamed card in deck order (deeper pool).
 */
export function buildDealOrder(
  activeSeats: readonly Seat[],
  hands: Partial<Record<Seat, readonly string[]>>,
  poolTop: readonly string[] = [],
): Card[] {
  const handSize = handSizeFor(activeSeats.length);
  const named = new Set<string>();
  const take = (ids: readonly string[]): Card[] => {
    for (const id of ids) {
      if (named.has(id)) throw new Error(`duplicate test card id: ${id}`);
      named.add(id);
    }
    return cardsOf(ids);
  };
  const order: Card[] = [];
  const namedHands = activeSeats.map((seat) => {
    const ids = hands[seat];
    if (ids && ids.length !== handSize) throw new Error(`seat ${seat} hand must hold ${handSize} ids, got ${ids.length}`);
    return ids ? take(ids) : null;
  });
  const pool = take(poolTop);
  const filler = createDeck().filter((c) => !named.has(c.id));
  for (const hand of namedHands) order.push(...(hand ?? filler.splice(0, handSize)));
  order.push(...pool, ...filler);
  return order;
}

export function game(
  activeSeats: readonly Seat[],
  hands: Partial<Record<Seat, readonly string[]>>,
  poolTop: readonly string[] = [],
  firstSeat: Seat = activeSeats[0],
  baseStake = 10,
): GameState {
  return createGame({ shuffledDeck: buildDealOrder(activeSeats, hands, poolTop), activeSeats, firstSeat, baseStake });
}

/** Apply an action that must succeed; throws with the rejection reason otherwise. */
export function act(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  return result.state;
}

export function ask(state: GameState, seat: Seat, target: Seat, rank: number): GameState {
  return act(state, seat, { type: "ask", target, rank });
}

export function expectRejected(state: GameState, seat: Seat, action: Action, reason: RejectionReason): void {
  const result = applyAction(state, seat, action);
  if (result.ok) throw new Error(`expected rejection ${reason}, but action succeeded`);
  if (result.reason !== reason) throw new Error(`expected rejection ${reason}, got ${result.reason}`);
}

export function playing(state: GameState) {
  if (state.phase !== "playing") throw new Error(`expected playing state, got ${state.phase}`);
  return state;
}

export function ids(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id);
}
