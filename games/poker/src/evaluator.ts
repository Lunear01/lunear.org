import type { Card, Rank } from "./cards";

export type HandCategory =
  | "high-card"
  | "pair"
  | "two-pair"
  | "trips"
  | "straight"
  | "flush"
  | "full-house"
  | "quads"
  | "straight-flush";

/** Category strength order, low to high — index doubles as a comparable numeric rank. */
const CATEGORY_ORDER: readonly HandCategory[] = [
  "high-card",
  "pair",
  "two-pair",
  "trips",
  "straight",
  "flush",
  "full-house",
  "quads",
  "straight-flush",
];

const CATEGORY_STRENGTH: Readonly<Record<HandCategory, number>> = Object.fromEntries(
  CATEGORY_ORDER.map((category, i) => [category, i]),
) as Record<HandCategory, number>;

export interface HandResult {
  readonly category: HandCategory;
  /**
   * Tiebreak ranks, most significant first, meaningful only within the same
   * category. Two same-category hands compare by walking this array
   * left-to-right; the exact shape per category:
   *   high-card / flush : all 5 ranks, descending
   *   pair               : [pairRank, kicker, kicker, kicker]           (3 kickers desc)
   *   two-pair           : [highPairRank, lowPairRank, kicker]
   *   trips              : [tripsRank, kicker, kicker]
   *   straight / straight-flush : [highCardOfStraight]  (wheel A-5 -> 5)
   *   full-house         : [tripsRank, pairRank]
   *   quads              : [quadRank, kicker]
   */
  readonly ranks: readonly number[];
  /** The best 5 cards making up this hand. */
  readonly cards: readonly Card[];
}

/** Positive if `a` beats `b`, negative if `b` beats `a`, 0 if they tie exactly. */
export function compareHands(a: HandResult, b: HandResult): number {
  const strengthDiff = CATEGORY_STRENGTH[a.category] - CATEGORY_STRENGTH[b.category];
  if (strengthDiff !== 0) return strengthDiff;
  for (let i = 0; i < a.ranks.length; i++) {
    const diff = a.ranks[i] - b.ranks[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function descByRank(cards: readonly Card[]): Card[] {
  return cards.slice().sort((x, y) => y.rank - x.rank);
}

/** 5 distinct ranks, descending; returns the straight's high card (wheel A-5-4-3-2 -> 5), or null. */
function straightHigh(distinctRanksDesc: readonly Rank[]): number | null {
  if (distinctRanksDesc.length !== 5) return null;
  const isWheel =
    distinctRanksDesc[0] === 14 &&
    distinctRanksDesc[1] === 5 &&
    distinctRanksDesc[2] === 4 &&
    distinctRanksDesc[3] === 3 &&
    distinctRanksDesc[4] === 2;
  if (isWheel) return 5;
  // 5 distinct integers, sorted descending: if the span from highest to lowest
  // is exactly 4, they must be 5 consecutive integers (pigeonhole) — no gaps
  // are possible with 5 distinct values packed into a span of 4.
  return distinctRanksDesc[0] - distinctRanksDesc[4] === 4 ? distinctRanksDesc[0] : null;
}

/** Classify a specific 5-card hand (order-independent). */
export function classifyFiveCardHand(cards: readonly Card[]): HandResult {
  if (cards.length !== 5) throw new Error(`classifyFiveCardHand requires exactly 5 cards, got ${cards.length}`);

  const sorted = descByRank(cards);
  const isFlush = sorted.every((c) => c.suit === sorted[0].suit);

  const countByRank = new Map<number, number>();
  for (const c of sorted) countByRank.set(c.rank, (countByRank.get(c.rank) ?? 0) + 1);
  // Groups ordered by (count desc, rank desc) — e.g. a full house's trips group before its pair,
  // two-pair's higher pair before its lower pair, and kickers within a tied count by rank.
  const groups = [...countByRank.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((x, y) => y.count - x.count || y.rank - x.rank);

  const distinctRanksDesc = groups.map((g) => g.rank);
  const straightTop = groups.length === 5 ? straightHigh(distinctRanksDesc as Rank[]) : null;

  if (isFlush && straightTop !== null) {
    return { category: "straight-flush", ranks: [straightTop], cards: sorted };
  }
  if (groups[0].count === 4) {
    return { category: "quads", ranks: [groups[0].rank, groups[1].rank], cards: sorted };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { category: "full-house", ranks: [groups[0].rank, groups[1].rank], cards: sorted };
  }
  if (isFlush) {
    return { category: "flush", ranks: distinctRanksDesc, cards: sorted };
  }
  if (straightTop !== null) {
    return { category: "straight", ranks: [straightTop], cards: sorted };
  }
  if (groups[0].count === 3) {
    return { category: "trips", ranks: [groups[0].rank, groups[1].rank, groups[2].rank], cards: sorted };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    return { category: "two-pair", ranks: [groups[0].rank, groups[1].rank, groups[2].rank], cards: sorted };
  }
  if (groups[0].count === 2) {
    return { category: "pair", ranks: [groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank], cards: sorted };
  }
  return { category: "high-card", ranks: distinctRanksDesc, cards: sorted };
}

/** All k-element subsets of `items`, order-preserving within each subset. */
function combinations<T>(items: readonly T[], k: number): T[][] {
  const results: T[][] = [];
  const current: T[] = [];
  function recurse(start: number): void {
    if (current.length === k) {
      results.push(current.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]);
      recurse(i + 1);
      current.pop();
    }
  }
  recurse(0);
  return results;
}

/**
 * Best possible 5-card hand out of an arbitrary pool of >=5 cards (7 at a
 * real showdown: 2 hole + 5 community). Brute-forces every 5-card subset
 * (C(7,5) = 21) and classifies each rather than a clever incremental
 * evaluator — this is the correctness-critical piece of the whole engine, so
 * "obviously correct" wins over "fast"; 21 classifications per showdown call
 * is immaterial.
 */
export function evaluateBestHand(cards: readonly Card[]): HandResult {
  if (cards.length < 5) throw new Error(`evaluateBestHand requires at least 5 cards, got ${cards.length}`);
  let best: HandResult | null = null;
  for (const combo of combinations(cards, 5)) {
    const result = classifyFiveCardHand(combo);
    if (best === null || compareHands(result, best) > 0) best = result;
  }
  return best!;
}
