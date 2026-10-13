// Card model, shared scheme with doudizhu/chudaidi so web reuses PlayingCard:
// ranks 3..15 (A=14, 2=15), suits D/C/H/S. Go Fish only cares about rank.

export type Suit = "D" | "C" | "H" | "S";

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
} as const;

export type Rank = (typeof RANK)[keyof typeof RANK];

export interface Card {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit;
}

/** Suit order, lowest first. */
export const SUITS: readonly Suit[] = ["D", "C", "H", "S"];
/** The 13 ranks a book can be made of. */
export const RANKS: readonly Rank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

export const SUIT_ORDER: Record<Suit, number> = { D: 0, C: 1, H: 2, S: 3 };

export const RANK_LABEL: Record<Rank, string> = {
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
};

/** Fixed-order 52-card deck. Caller shuffles. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${RANK_LABEL[rank]}${suit}`, rank, suit });
    }
  }
  return deck;
}

/** Total order over cards: rank first, then suit. */
export function cardValue(card: Card): number {
  return card.rank * 4 + SUIT_ORDER[card.suit];
}

export function compareCards(a: Card, b: Card): number {
  return cardValue(a) - cardValue(b);
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

/** Deterministic seeded RNG (mulberry32) for reproducible shuffles in tests. */
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
  return cards.slice().sort(compareCards);
}
