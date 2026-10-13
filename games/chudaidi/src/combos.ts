import { RANK, SUIT_ORDER, cardValue, type Card } from "./cards";

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

/** Five-card categories, weakest first. */
const FIVE_CARD_RANK: Record<ComboCategory, number> = {
  single: 0,
  pair: 0,
  triple: 0,
  straight: 0,
  flush: 1,
  fullHouse: 2,
  fourOfAKind: 3,
  straightFlush: 4,
};

/**
 * Straight ladder index, or null if the ranks are not a straight.
 * 3-4-5-6-7 .. 10-J-Q-K-A index by top rank (7..14); A-2-3-4-5 is 16 and
 * 2-3-4-5-6 is 17, the highest. J-Q-K-A-2 is not a straight.
 */
function straightIndex(sortedRanks: readonly number[]): number | null {
  const [r0, r1, r2, r3, r4] = sortedRanks;
  if (r0 === 3 && r1 === 4 && r2 === 5 && r3 === 6 && r4 === RANK.Two) return 17;
  if (r0 === 3 && r1 === 4 && r2 === 5 && r3 === RANK.Ace && r4 === RANK.Two) return 16;
  for (let i = 1; i < 5; i++) {
    if (sortedRanks[i] !== sortedRanks[i - 1] + 1) return null;
  }
  if (r4 > RANK.Ace) return null;
  return r4;
}

/** Suit order of the card holding the top rank (the 2 in both wrap straights). */
function topCardSuitOrder(cards: readonly Card[]): number {
  let top = cards[0];
  for (const card of cards) if (card.rank > top.rank) top = card;
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
  const groups = [...byRank.values()].sort((a, b) => b.length - a.length || a[0].rank - b[0].rank);

  if (cards.length === 1) return { category: "single", cards, strength: cardValue(cards[0]) };

  if (cards.length === 2) {
    if (groups.length !== 1) return null;
    const topSuit = Math.max(...cards.map((c) => SUIT_ORDER[c.suit]));
    return { category: "pair", cards, strength: cards[0].rank * 4 + topSuit };
  }

  if (cards.length === 3) {
    if (groups.length !== 1) return null;
    return { category: "triple", cards, strength: cards[0].rank };
  }

  if (cards.length !== 5) return null;

  if (groups.length === 2 && groups[0].length === 4) {
    return { category: "fourOfAKind", cards, strength: groups[0][0].rank };
  }
  if (groups.length === 2 && groups[0].length === 3) {
    return { category: "fullHouse", cards, strength: groups[0][0].rank };
  }

  const sortedRanks = cards.map((c) => c.rank).sort((a, b) => a - b);
  const straight = groups.length === 5 ? straightIndex(sortedRanks) : null;
  const flush = cards.every((c) => c.suit === cards[0].suit);

  if (straight !== null && flush) {
    return { category: "straightFlush", cards, strength: straight * 4 + topCardSuitOrder(cards) };
  }
  if (flush) {
    return { category: "flush", cards, strength: SUIT_ORDER[cards[0].suit] * 16 + sortedRanks[4] };
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
    const prevRank = FIVE_CARD_RANK[previous.category];
    const nextRank = FIVE_CARD_RANK[next.category];
    if (nextRank !== prevRank) return nextRank > prevRank;
  }
  return next.strength > previous.strength;
}
