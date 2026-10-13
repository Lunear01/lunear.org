import type { Card } from "./cards";

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];
export const HAND_SIZE = 13;

/** Next seat in `activeSeats` after `seat`, wrapping. `seat` must be active. */
export function nextActiveSeat(activeSeats: readonly Seat[], seat: Seat): Seat {
  const index = activeSeats.indexOf(seat);
  if (index === -1) throw new Error(`nextActiveSeat: seat ${seat} is not active`);
  return activeSeats[(index + 1) % activeSeats.length];
}

/**
 * 13 cards to each active seat from a shuffled 52-card deck. Seat N always
 * takes block [13N, 13N+13), so an inactive seat's block stays undealt.
 */
export function dealHands(shuffledDeck: readonly Card[], activeSeats: readonly Seat[]): Record<Seat, readonly Card[]> {
  if (shuffledDeck.length !== 52) {
    throw new Error(`dealHands requires exactly 52 cards, got ${shuffledDeck.length}`);
  }
  const active = new Set(activeSeats);
  const block = (seat: Seat): readonly Card[] =>
    active.has(seat) ? shuffledDeck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE) : [];
  return { 0: block(0), 1: block(1), 2: block(2), 3: block(3) };
}
