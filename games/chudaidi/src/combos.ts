import { MAX_STRENGTH, SUIT_ORDER, cardValue, rankStrength, type Card } from "./cards";

export type ComboCategory =
  | "single"
  | "pair"
  | "triple"
  | "straight"
  | "flush"
  | "fullHouse"
  | "fourOfAKind"
  | "straightFlush";

export interface Combo {
  readonly category: ComboCategory;
  readonly cards: readonly Card[];
  /** Comparison key among combos of the same category; higher wins. */
  readonly strength: number;
}

/** Five-card categories, weakest first; 0 for the one-rank shapes. */
export function fiveCardRank(category: ComboCategory): number {
  switch (category) {
    case "flush":
      return 1;
    case "fullHouse":
      return 2;
    case "fourOfAKind":
      return 3;
    case "straightFlush":
      return 4;
    default:
      return 0;
  }
}

/**
 * Straight ladder index, or null if the strengths are not a straight.
 * Plain straights run 4-5-6-7-8 .. J-Q-K-A-2, indexed by top strength (4..11);
 * 2-3-4-5-6 is 16 and 3-4-5-6-7 is 17, the highest. Q-K-A-2-3 is not a straight.
 */
function straightIndex(sortedStrengths: readonly number[]): number | null {
  const [s0, s1, s2, s3, s4] = sortedStrengths;
  if (s0 === 0 && s1 === 1 && s2 === 2 && s3 === 3 && s4 === MAX_STRENGTH) return 17;
  if (s0 === 0 && s1 === 1 && s2 === 2 && s3 === MAX_STRENGTH - 1 && s4 === MAX_STRENGTH) return 16;
  for (let i = 1; i < 5; i++) {
    if (sortedStrengths[i] !== sortedStrengths[i - 1] + 1) return null;
  }
  if (s4 >= MAX_STRENGTH) return null;
  return s4;
}

/** Suit order of the strongest-ranked card (the 3 in both wrap straights). */
function topCardSuitOrder(cards: readonly Card[]): number {
  let top = cards[0];
  for (const card of cards) if (rankStrength(card.rank) > rankStrength(top.rank)) top = card;
  return SUIT_ORDER[top.suit];
}

/**
 * Classify an exact selection into a combo, or null for an illegal shape.
 * Card identity is the caller's job; this only judges shape.
 */
export function classifyCombo(cards: readonly Card[]): Combo | null {
  if (cards.length === 0) return null;
  if (new Set(cards.map((c) => c.id)).size !== cards.length) return null;

  const byRank = new Map<number, Card[]>();
  for (const card of cards) {
    const group = byRank.get(card.rank);
    if (group) group.push(card);
    else byRank.set(card.rank, [card]);
  }
  const groups = [...byRank.values()].sort(
    (a, b) => b.length - a.length || rankStrength(a[0].rank) - rankStrength(b[0].rank),
  );

  if (cards.length === 1) return { category: "single", cards, strength: cardValue(cards[0]) };

  if (cards.length === 2) {
    if (groups.length !== 1) return null;
    const topSuit = Math.max(...cards.map((c) => SUIT_ORDER[c.suit]));
    return { category: "pair", cards, strength: rankStrength(cards[0].rank) * 4 + topSuit };
  }

  if (cards.length === 3) {
    if (groups.length !== 1) return null;
    return { category: "triple", cards, strength: rankStrength(cards[0].rank) };
  }

  if (cards.length !== 5) return null;

  if (groups.length === 2 && groups[0].length === 4) {
    return { category: "fourOfAKind", cards, strength: rankStrength(groups[0][0].rank) };
  }
  if (groups.length === 2 && groups[0].length === 3) {
    return { category: "fullHouse", cards, strength: rankStrength(groups[0][0].rank) };
  }

  const sortedStrengths = cards.map((c) => rankStrength(c.rank)).sort((a, b) => a - b);
  const straight = groups.length === 5 ? straightIndex(sortedStrengths) : null;
  const flush = cards.every((c) => c.suit === cards[0].suit);

  if (straight !== null && flush) {
    return { category: "straightFlush", cards, strength: straight * 4 + topCardSuitOrder(cards) };
  }
  if (flush) {
    return { category: "flush", cards, strength: SUIT_ORDER[cards[0].suit] * 16 + sortedStrengths[4] };
  }
  if (straight !== null) {
    return { category: "straight", cards, strength: straight * 4 + topCardSuitOrder(cards) };
  }
  return null;
}

/** True if `next` beats `previous`: same card count, then category (five-card only), then strength. */
export function beats(previous: Combo, next: Combo): boolean {
  if (previous.cards.length !== next.cards.length) return false;
  if (next.cards.length === 5) {
    const prevRank = fiveCardRank(previous.category);
    const nextRank = fiveCardRank(next.category);
    if (nextRank !== prevRank) return nextRank > prevRank;
  }
  return next.strength > previous.strength;
}
