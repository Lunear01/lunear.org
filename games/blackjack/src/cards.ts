// Card model for blackjack. Ranks reuse poker's numeric 2..14 scheme (J=11,
// Q=12, K=13, A=14) so the web's card components render either game's cards
// unchanged; blackjack hand VALUES (face cards 10, ace 1 or 11) live in
// game.ts's handValue, never in rank comparisons here.
export type Suit = "c" | "d" | "h" | "s";

export const RANK = {
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
  Ten: 10,
  Jack: 11,
  Queen: 12,
  King: 13,
  Ace: 14,
} as const;

export type Rank = (typeof RANK)[keyof typeof RANK];

export interface Card {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit;
}

const SUITS: readonly Suit[] = ["c", "d", "h", "s"];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_LABEL: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

/** Standard shoe size: 6 decks, reshuffled every round (no cut-card tracking). */
export const SHOE_DECKS = 6;

/**
 * Fixed-order shoe of `decks` x 52 cards. Caller shuffles. Ids carry the deck
 * index (`As#2`) so every card in the shoe is unique — clients key card
 * elements by id, and a 6-deck shoe repeats each rank/suit six times.
 */
export function createShoe(decks: number = SHOE_DECKS): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        shoe.push({ id: `${RANK_LABEL[rank]}${suit}#${d}`, rank, suit });
      }
    }
  }
  return shoe;
}

/** Signature-compatible with Math.random: returns a float in [0, 1). */
export type RandomSource = () => number;

/** Fisher-Yates shuffle driven by a caller-supplied RNG. Does not mutate `cards`. */
export function shuffleCards(cards: readonly Card[], random: RandomSource): Card[] {
  const result = cards.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/**
 * Deterministic seeded RNG (mulberry32), offered as a convenience for callers
 * that need reproducible shuffles (tests, replay). The engine itself never
 * calls this internally — every entry point takes a shoe as input.
 */
export function createSeededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
