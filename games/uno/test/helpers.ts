import { expect } from "vitest";
import { createDeck, createSeededRandom, type Card, type RandomSource } from "../src/cards";
import { applyAction, createGame, type Action, type GameState, type PlayingState, type Seat } from "../src/game";

/** Full canonical deck indexed by id ("r7a", "bSb", "W4c", ...). */
export const DECK_BY_ID: ReadonlyMap<string, Card> = new Map(createDeck().map((c) => [c.id, c]));

export function cardsOf(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = DECK_BY_ID.get(id);
    if (!card) throw new Error(`unknown test card id: ${id}`);
    return card;
  });
}

export interface DealScript {
  /** Per active seat, in seat order: the exact 7-card hand. */
  readonly hands: Partial<Record<Seat, readonly string[]>>;
  /** Cards flipped for the first discard, in flip order; the last must be a number card. */
  readonly flips: readonly string[];
  /** Draw pile after the flip, top first. The rest of the deck pads the bottom. */
  readonly draws?: readonly string[];
}

/**
 * Builds a 108-card deck that createGame deals into the scripted hands
 * (seat blocks in seat order), flips `flips`, then draws `draws` in order.
 */
export function buildDeck(script: DealScript): Card[] {
  const used = new Set<string>();
  const take = (ids: readonly string[]) => {
    for (const id of ids) {
      if (used.has(id)) throw new Error(`duplicate test card id: ${id}`);
      used.add(id);
    }
    return ids;
  };
  const order: string[] = [];
  const seats = (Object.keys(script.hands).map(Number) as Seat[]).sort((a, b) => a - b);
  for (const seat of seats) {
    const hand = script.hands[seat]!;
    if (hand.length !== 7) throw new Error(`seat ${seat} hand must have 7 cards, got ${hand.length}`);
    order.push(...take(hand));
  }
  order.push(...take(script.flips));
  order.push(...take(script.draws ?? []));
  const filler = [...DECK_BY_ID.keys()].filter((id) => !used.has(id));
  order.push(...filler);
  return cardsOf(order);
}

export const NO_RANDOM: RandomSource = () => {
  throw new Error("unexpected reshuffle");
};

export const seeded = (seed = 1): RandomSource => createSeededRandom(seed);

export function newGame(script: DealScript, options: { firstSeat?: Seat; baseStake?: number } = {}): PlayingState {
  const activeSeats = (Object.keys(script.hands).map(Number) as Seat[]).sort((a, b) => a - b);
  return createGame({
    shuffledDeck: buildDeck(script),
    activeSeats,
    firstSeat: options.firstSeat ?? activeSeats[0],
    baseStake: options.baseStake ?? 100,
  });
}

/** Applies an action that must succeed; throws with the rejection reason otherwise. */
export function act(state: GameState, seat: Seat, action: Action, random: RandomSource = NO_RANDOM): GameState {
  const result = applyAction(state, seat, action, random);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  return result.state;
}

export function expectRejected(
  state: GameState,
  seat: Seat,
  action: Action,
  reason: string,
  random: RandomSource = NO_RANDOM,
): void {
  const result = applyAction(state, seat, action, random);
  expect(result).toEqual({ ok: false, reason });
}

export function playing(state: GameState): PlayingState {
  if (state.phase !== "playing") throw new Error(`expected playing state, got ${state.phase}`);
  return state;
}

export function ids(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id);
}
