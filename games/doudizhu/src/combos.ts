import { MAX_SEQUENCE_RANK, RANK, type Card, type Rank } from "./cards";

export type ComboCategory =
  | "single"
  | "pair"
  | "triple"
  | "triplePlusSingle"
  | "triplePlusPair"
  | "straight"
  | "pairStraight"
  | "plane"
  | "planePlusSingles"
  | "planePlusPairs"
  | "fourPlusTwoSingles"
  | "fourPlusTwoPairs"
  | "bomb"
  | "rocket";

export interface Combo {
  readonly category: ComboCategory;
  readonly cards: readonly Card[];
  /** Rank used for comparison: lowest rank of a sequence, or the repeated unit's rank otherwise. */
  readonly mainRank: number;
  /** Sequence unit count (straight length, pair-straight pair count, plane triple count); 1 otherwise. */
  readonly length: number;
}

interface RankGroup {
  rank: Rank;
  cards: Card[];
}

function groupByRank(cards: readonly Card[]): RankGroup[] {
  const byRank = new Map<Rank, Card[]>();
  for (const card of cards) {
    const existing = byRank.get(card.rank);
    if (existing) existing.push(card);
    else byRank.set(card.rank, [card]);
  }
  return [...byRank.entries()]
    .map(([rank, groupCards]) => ({ rank, cards: groupCards }))
    .sort((a, b) => a.rank - b.rank);
}

function isConsecutive(groups: readonly RankGroup[]): boolean {
  for (let i = 1; i < groups.length; i++) {
    if (groups[i].rank !== groups[i - 1].rank + 1) return false;
  }
  return true;
}

/**
 * Classify an exact card selection into a single legal combo, or null if the
 * selection matches no legal shape. Card *identity* isn't verified here (that
 * a card actually belongs to the player's hand is the caller's job) — this
 * only judges shape.
 */
export function classifyCombo(cards: readonly Card[]): Combo | null {
  if (cards.length === 0) return null;
  const ids = new Set(cards.map((c) => c.id));
  if (ids.size !== cards.length) return null; // same card selected twice

  const groups = groupByRank(cards);

  // Rocket: both jokers, nothing else.
  if (
    cards.length === 2 &&
    groups.length === 2 &&
    groups[0].rank === RANK.BlackJoker &&
    groups[1].rank === RANK.RedJoker
  ) {
    return { category: "rocket", cards, mainRank: RANK.RedJoker, length: 1 };
  }

  // Single rank-group shapes: single / pair / triple / bomb.
  if (groups.length === 1) {
    const { rank, cards: groupCards } = groups[0];
    switch (groupCards.length) {
      case 1:
        return { category: "single", cards, mainRank: rank, length: 1 };
      case 2:
        return { category: "pair", cards, mainRank: rank, length: 1 };
      case 3:
        return { category: "triple", cards, mainRank: rank, length: 1 };
      case 4:
        return { category: "bomb", cards, mainRank: rank, length: 1 };
      default:
        return null;
    }
  }

  // Four-of-a-kind + kickers. Must resolve before the triple/plane checks
  // below, so a leftover 4th copy of a would-be triple's rank can't sneak in
  // as a "kicker" (that shape must fail, not be reinterpreted).
  const quadGroups = groups.filter((g) => g.cards.length === 4);
  if (quadGroups.length === 1) {
    const quad = quadGroups[0];
    const remainder = groups.filter((g) => g !== quad);
    const remainderTotal = cards.length - 4;
    if (remainderTotal === 2) {
      return { category: "fourPlusTwoSingles", cards, mainRank: quad.rank, length: 1 };
    }
    if (remainderTotal === 4 && remainder.length === 2 && remainder.every((g) => g.cards.length === 2)) {
      return { category: "fourPlusTwoPairs", cards, mainRank: quad.rank, length: 1 };
    }
    return null;
  }
  if (quadGroups.length >= 2) return null;

  // Straight: >=5 consecutive singles, 3..A only (no 2, no jokers).
  if (groups.every((g) => g.cards.length === 1)) {
    const maxRank = groups[groups.length - 1].rank;
    if (groups.length >= 5 && isConsecutive(groups) && maxRank <= MAX_SEQUENCE_RANK) {
      return { category: "straight", cards, mainRank: groups[0].rank, length: groups.length };
    }
    return null;
  }

  // Pair straight: >=3 consecutive pairs, 3..A only.
  if (groups.every((g) => g.cards.length === 2)) {
    const maxRank = groups[groups.length - 1].rank;
    if (groups.length >= 3 && isConsecutive(groups) && maxRank <= MAX_SEQUENCE_RANK) {
      return { category: "pairStraight", cards, mainRank: groups[0].rank, length: groups.length };
    }
    return null;
  }

  // Triple / plane, optionally with single or pair kickers (kicker count === triple count).
  const tripleGroups = groups.filter((g) => g.cards.length === 3);
  if (tripleGroups.length === 0) return null;

  const n = tripleGroups.length;
  if (!isConsecutive(tripleGroups)) return null;
  const maxTripleRank = tripleGroups[tripleGroups.length - 1].rank;
  // A lone triple may be rank 2 (e.g. "222" or "222+5"); a real plane (n>=2)
  // may not, since 2s never take part in a sequence.
  if (n >= 2 && maxTripleRank > MAX_SEQUENCE_RANK) return null;

  const remainderGroups = groups.filter((g) => g.cards.length !== 3);
  const mainRank = tripleGroups[0].rank;

  if (remainderGroups.length === 0) {
    return { category: n === 1 ? "triple" : "plane", cards, mainRank, length: n };
  }
  if (remainderGroups.length === n && remainderGroups.every((g) => g.cards.length === 1)) {
    return { category: n === 1 ? "triplePlusSingle" : "planePlusSingles", cards, mainRank, length: n };
  }
  if (remainderGroups.length === n && remainderGroups.every((g) => g.cards.length === 2)) {
    return { category: n === 1 ? "triplePlusPair" : "planePlusPairs", cards, mainRank, length: n };
  }
  return null;
}

/** True if `next` legally beats `previous` under standard Dou Dizhu comparison. */
export function beats(previous: Combo, next: Combo): boolean {
  if (previous.category === "rocket") return false; // unbeatable
  if (next.category === "rocket") return true; // rocket beats everything else
  if (next.category === "bomb") {
    if (previous.category !== "bomb") return true; // bomb beats any non-bomb, non-rocket
    return next.mainRank > previous.mainRank; // bigger bomb beats smaller bomb
  }
  if (previous.category === "bomb") return false; // only a bigger bomb / rocket beats a bomb (handled above)
  if (next.category !== previous.category) return false;
  if (next.length !== previous.length) return false;
  return next.mainRank > previous.mainRank;
}
