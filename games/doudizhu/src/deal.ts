import type { Card } from "./cards";

export type Seat = 0 | 1 | 2;
export const SEATS: readonly Seat[] = [0, 1, 2];

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 3) as Seat;
}

export interface DealResult {
  hands: Record<Seat, Card[]>;
  /** 3 face-down cards, awarded to whoever wins the bid. */
  landlordCards: Card[];
}

/** 17/17/17 + 3 split. Requires exactly 54 pre-shuffled cards (caller's job). */
export function dealHands(shuffledDeck: readonly Card[]): DealResult {
  if (shuffledDeck.length !== 54) {
    throw new Error(`dealHands requires exactly 54 cards, got ${shuffledDeck.length}`);
  }
  return {
    hands: {
      0: shuffledDeck.slice(0, 17),
      1: shuffledDeck.slice(17, 34),
      2: shuffledDeck.slice(34, 51),
    },
    landlordCards: shuffledDeck.slice(51, 54),
  };
}
