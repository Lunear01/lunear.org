import type { Card } from "./cards";

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];

/** Raw seat-index rotation, ignoring alive/hand status entirely. */
export function nextSeatInRotation(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

interface AliveLookup {
  readonly [seat: number]: { readonly alive: boolean };
}

/**
 * Next seat after `fromSeat`, skipping dead seats, using only `players[*].alive`
 * (hand contents are irrelevant here). Used both for ordinary turn advancement
 * and for picking who is deemed "the challenger" when a forced/auto-challenge
 * fires — in that case the picked seat may itself hold zero cards, which is
 * fine, since a challenge never requires the challenger to hold cards.
 *
 * Assumes at least one OTHER seat is alive; the engine only ever calls this
 * from states where more than one player remains alive. If every other seat
 * were dead, this falls back to returning `fromSeat` itself rather than
 * looping forever — that path is unreachable in practice (an alive count of 1
 * always transitions the game to "finished" before another rotation lookup
 * would occur).
 */
export function nextAliveSeat(players: AliveLookup, fromSeat: Seat): Seat {
  let seat = nextSeatInRotation(fromSeat);
  for (let i = 0; i < 3; i++) {
    if (players[seat].alive) return seat;
    seat = nextSeatInRotation(seat);
  }
  // None of the other 3 seats is alive. If fromSeat itself still is, that's
  // the legitimate "only one player left" edge case described above.
  if (players[fromSeat].alive) return fromSeat;
  throw new Error(`nextAliveSeat: no alive seat found starting after seat ${fromSeat}`);
}

interface HandLookup {
  readonly [seat: number]: readonly Card[];
}

/**
 * Next seat after `fromSeat` that is both alive and still holds cards.
 * Only ever called once the caller has already confirmed such a seat exists
 * among the OTHER alive players (see game.ts's post-play auto-challenge
 * check) — if none exists, that's an engine invariant violation, so this
 * throws rather than silently returning a wrong/empty-handed seat.
 */
export function nextAliveSeatWithCards(hands: HandLookup, players: AliveLookup, fromSeat: Seat): Seat {
  let seat = nextSeatInRotation(fromSeat);
  for (let i = 0; i < 3; i++) {
    if (players[seat].alive && hands[seat].length > 0) return seat;
    seat = nextSeatInRotation(seat);
  }
  throw new Error(
    `nextAliveSeatWithCards: no alive seat with cards found after seat ${fromSeat}; caller invariant violated`,
  );
}

/**
 * Deal 5 cards to each alive seat from a freshly shuffled full 20-card deck.
 * Each seat has a fixed reserved 5-card block (seat N -> [5N, 5N+5)) regardless
 * of who is alive this round — a dead seat's block is simply discarded rather
 * than being handed to a later alive seat. This keeps dealing position-stable
 * and simple to reason about (and to construct in tests), at the cost of
 * "wasting" some cards when fewer than 4 players remain alive, which is free
 * since the deck is freshly shuffled every round anyway.
 */
export function dealHands(shuffledDeck: readonly Card[], aliveSeats: readonly Seat[]): Record<Seat, readonly Card[]> {
  if (shuffledDeck.length !== 20) {
    throw new Error(`dealHands requires exactly 20 cards, got ${shuffledDeck.length}`);
  }
  const alive = new Set(aliveSeats);
  return {
    0: alive.has(0) ? shuffledDeck.slice(0, 5) : [],
    1: alive.has(1) ? shuffledDeck.slice(5, 10) : [],
    2: alive.has(2) ? shuffledDeck.slice(10, 15) : [],
    3: alive.has(3) ? shuffledDeck.slice(15, 20) : [],
  };
}
