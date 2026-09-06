// Card model. Ranks are numeric so plain `<`/`>` gives correct strength order:
// 3<4<...<K<A<2<blackJoker<redJoker. Suits never affect comparison.
export type Suit = "S" | "H" | "D" | "C" | "JOKER";

export const RANK = {
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
  Two: 15,
  BlackJoker: 16,
  RedJoker: 17,
} as const;

export type Rank = (typeof RANK)[keyof typeof RANK];

/** Highest rank usable in straights / pair-straights / planes (excludes 2 and both jokers). */
export const MAX_SEQUENCE_RANK: Rank = RANK.Ace;

export interface Card {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit;
}

const SUITS: readonly Exclude<Suit, "JOKER">[] = ["S", "H", "D", "C"];
const SUIT_RANKS: readonly Rank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const RANK_LABEL: Record<Rank, string> = {
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
  15: "2",
  16: "BJ",
  17: "RJ",
};

/** Fixed-order 54-card deck (3..2 x 4 suits + both jokers). Caller shuffles. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of SUIT_RANKS) {
      deck.push({ id: `${RANK_LABEL[rank]}${suit}`, rank, suit });
    }
  }
  deck.push({ id: "BJ", rank: RANK.BlackJoker, suit: "JOKER" });
  deck.push({ id: "RJ", rank: RANK.RedJoker, suit: "JOKER" });
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
 * calls this internally — every entry point takes a deck or RNG as input.
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

export function sortHand(cards: readonly Card[]): Card[] {
  return cards.slice().sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit));
}
