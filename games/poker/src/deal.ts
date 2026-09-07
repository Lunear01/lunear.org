import type { Card } from "./cards";

// Unlike doudizhu (fixed 3 seats) and liarsbar (fixed 4 seats), a poker table
// seats 2-8 players at seat numbers 0..7 that need not be contiguous (e.g. a
// 3-player game might occupy seats [0, 3, 5]). So Seat is a plain number, and
// every seat-keyed record here only ever holds entries for the seats actually
// in play — never all of 0..7.
export type Seat = number;

/** Ascending order == clockwise seating order for seats 0..7. */
export function sortSeats(seats: readonly Seat[]): Seat[] {
  return seats.slice().sort((a, b) => a - b);
}

/**
 * All of `seats`, rotated to start at `start` and proceed clockwise
 * (ascending, wrapping past 7 back to the lowest occupied seat). `start` must
 * be one of `seats`; every caller here only ever passes an occupied seat
 * (dealer/blinds/first-to-act are always resolved from the seat list itself).
 */
export function orderFrom(seats: readonly Seat[], start: Seat): Seat[] {
  const sorted = sortSeats(seats);
  const startIndex = sorted.indexOf(start);
  if (startIndex === -1) throw new Error(`orderFrom: seat ${start} is not among ${JSON.stringify(sorted)}`);
  return [...sorted.slice(startIndex), ...sorted.slice(0, startIndex)];
}

/** Next occupied seat strictly after `from`, wrapping around. `from` need not itself be occupied. */
export function nextOccupiedSeat(seats: readonly Seat[], from: Seat): Seat {
  const sorted = sortSeats(seats);
  const next = sorted.find((s) => s > from);
  return next ?? sorted[0];
}

/** Rotates the dealer button to the next occupied seat clockwise. Exposed so the caller (e.g. a table
 * Durable Object) can advance the button between hands — this engine only ever plays one hand per call. */
export function nextDealerSeat(seats: readonly Seat[], currentDealer: Seat): Seat {
  return nextOccupiedSeat(seats, currentDealer);
}

export interface BlindSeats {
  readonly smallBlind: Seat;
  readonly bigBlind: Seat;
}

/**
 * Small blind / big blind seat assignment. Heads-up (2 players) is the
 * standard exception: the dealer themself posts the small blind (and, per
 * the caller's betting-order logic, acts first preflop / last postflop) —
 * with 3+ players the small blind is the next occupied seat after the
 * dealer, as usual.
 */
export function blindSeats(seats: readonly Seat[], dealerSeat: Seat): BlindSeats {
  if (seats.length === 2) {
    return { smallBlind: dealerSeat, bigBlind: nextOccupiedSeat(seats, dealerSeat) };
  }
  const smallBlind = nextOccupiedSeat(seats, dealerSeat);
  const bigBlind = nextOccupiedSeat(seats, smallBlind);
  return { smallBlind, bigBlind };
}

/**
 * First seat to act on a betting street. Preflop it's the seat after the big
 * blind (standard "under the gun"); postflop it's the seat after the dealer
 * button (standard "small blind acts first"). Both formulas happen to also
 * produce the correct heads-up inversion (dealer/SB acts first preflop, last
 * postflop) for free: with only 2 occupied seats, "next after the big blind"
 * wraps straight back around to the dealer, and "next after the dealer" lands
 * on the big blind — exactly the heads-up exception the spec calls out,
 * without any special-casing here.
 */
export function firstToActPreflop(seats: readonly Seat[], bigBlind: Seat): Seat {
  return nextOccupiedSeat(seats, bigBlind);
}

export function firstToActPostflop(seats: readonly Seat[], dealerSeat: Seat): Seat {
  return nextOccupiedSeat(seats, dealerSeat);
}

export interface DealHoleCardsResult {
  /** Two hole cards per seat, keyed by seat number (only occupied seats have entries). */
  readonly holeCards: Readonly<Record<Seat, readonly [Card, Card]>>;
  /** Whatever's left of the deck after hole cards, in order, for dealing the board. */
  readonly remainingDeck: readonly Card[];
}

/**
 * Deal 2 hole cards to each seat from a freshly shuffled 52-card deck. Cards
 * are handed out in one fixed block per seat, in ascending (clockwise) seat
 * order — seat i (by table position, not raw seat number) gets
 * shuffledDeck[2i, 2i+2) — rather than the traditional round-robin one-card-
 * at-a-time deal. Mirrors liarsbar's dealHands: block dealing is simpler to
 * reason about and to construct in tests, and is exactly as fair as
 * round-robin dealing since the deck arrives pre-shuffled either way.
 */
export function dealHoleCards(shuffledDeck: readonly Card[], seats: readonly Seat[]): DealHoleCardsResult {
  if (shuffledDeck.length !== 52) {
    throw new Error(`dealHoleCards requires exactly 52 cards, got ${shuffledDeck.length}`);
  }
  const sorted = sortSeats(seats);
  const holeCards: Record<Seat, readonly [Card, Card]> = {};
  sorted.forEach((seat, i) => {
    holeCards[seat] = [shuffledDeck[i * 2], shuffledDeck[i * 2 + 1]];
  });
  return { holeCards, remainingDeck: shuffledDeck.slice(sorted.length * 2) };
}
