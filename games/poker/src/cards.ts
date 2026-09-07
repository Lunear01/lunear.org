// Card model for Texas Hold'em. Ranks are numeric (2..14, ace-high) so plain
// `<`/`>` gives correct strength order; suits never affect rank comparison
// and only matter for flush detection in the evaluator.
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

/** Fixed-order 52-card deck (2..A x c/d/h/s). Caller shuffles. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${RANK_LABEL[rank]}${suit}`, rank, suit });
    }
  }
  return deck;
}

/** Signature-compatible with Math.random: returns a float in [0, 1). */
export type RandomSource = () => number;

/** Fisher-Yates shuffle driven by a caller-supplied RNG. Does not mutate `deck`. */
export function shuffleDeck(deck: readonly Card[], random: RandomSource): Card[] {
  const result = deck.slice();
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
 * calls this internally — every entry point takes a deck as input.
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
