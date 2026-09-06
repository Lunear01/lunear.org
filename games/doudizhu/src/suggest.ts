// Pure "hint" heuristic: given a hand and the combo it must beat (or null to
// lead), suggest which cards to play. Built entirely on classifyCombo/beats
// from ./combos — this module only decides *which* legal selection to try,
// it never reimplements what makes a selection legal.
import { MAX_SEQUENCE_RANK, RANK, type Card, type Rank } from "./cards";
import { beats, classifyCombo, type Combo, type ComboCategory } from "./combos";

export interface SuggestPlayOptions {
  /**
   * When false, a bomb/rocket is never suggested: a beat that would require
   * one returns null instead, and a lead that would require one (hand is
   * nothing but bombs/rocket material) falls back to using one anyway, since
   * a lead must always return a play. Default true.
   */
  readonly allowBombs?: boolean;
}

interface Group {
  readonly rank: Rank;
  readonly cards: readonly Card[];
}

/** Group hand cards by rank, ascending. Distinct from combos.ts's internal
 * groupByRank: that one classifies an exact selection, this one surveys the
 * whole hand to decide what to select. */
function groupByRank(hand: readonly Card[]): Group[] {
  const byRank = new Map<Rank, Card[]>();
  for (const card of hand) {
    const existing = byRank.get(card.rank);
    if (existing) existing.push(card);
    else byRank.set(card.rank, [card]);
  }
  return [...byRank.entries()]
    .map(([rank, cards]) => ({ rank, cards }))
    .sort((a, b) => a.rank - b.rank);
}

/** Cost of taking `used` cards from a same-rank group of `size`. 0 means the
 * group is fully consumed (no structure left behind to protect). Otherwise
 * the cost equals the group size, so breaking a pair < breaking a triple <
 * breaking a bomb (bombs are separately excluded outright, see below). */
function breakTier(size: number, used: number): number {
  return used === size ? 0 : size;
}

/** Groups usable as loose material for singles/pairs/triples/sequences/kickers.
 * Bombs (size 4) are never partially broken: they're only ever played whole,
 * as "bomb" or as the quad half of a four-plus-two. */
function nonBombGroups(groups: readonly Group[]): Group[] {
  return groups.filter((g) => g.cards.length < 4);
}

// --- single-unit candidate search (single / pair / triple) -----------------

interface UnitCandidate {
  readonly cards: Card[];
  readonly mainRank: number;
  readonly tier: number;
}

/** Best (fewest breaks, then lowest rank) way to supply `unitSize` cards of
 * one rank, strictly above `minRankExclusive`, excluding `excludeRanks`. */
function bestUnit(
  groups: readonly Group[],
  unitSize: number,
  minRankExclusive: number,
  excludeRanks: ReadonlySet<Rank> = new Set(),
): UnitCandidate | null {
  let best: UnitCandidate | null = null;
  for (const g of nonBombGroups(groups)) {
    if (g.rank <= minRankExclusive) continue;
    if (excludeRanks.has(g.rank)) continue;
    if (g.cards.length < unitSize) continue;
    const tier = breakTier(g.cards.length, unitSize);
    if (best === null || tier < best.tier || (tier === best.tier && g.rank < best.mainRank)) {
      best = { cards: g.cards.slice(0, unitSize), mainRank: g.rank, tier };
    }
  }
  return best;
}

/** Greedily pick `count` distinct-rank units of `unitSize` cards each (for
 * kickers), cheapest-first, excluding `excludeRanks`. Returns null if there
 * aren't enough qualifying ranks. */
function bestKickers(
  groups: readonly Group[],
  unitSize: number,
  count: number,
  excludeRanks: ReadonlySet<Rank>,
): Card[] | null {
  const candidates: UnitCandidate[] = [];
  for (const g of nonBombGroups(groups)) {
    if (excludeRanks.has(g.rank)) continue;
    if (g.cards.length < unitSize) continue;
    candidates.push({ cards: g.cards.slice(0, unitSize), mainRank: g.rank, tier: breakTier(g.cards.length, unitSize) });
  }
  candidates.sort((a, b) => a.tier - b.tier || a.mainRank - b.mainRank);
  if (candidates.length < count) return null;
  return candidates.slice(0, count).flatMap((c) => c.cards);
}

// --- sequence candidate search (straight / pairStraight / plane) -----------

interface SequenceCandidate {
  readonly startRank: number;
  readonly length: number;
  readonly tier: number;
}

/** All contiguous rank windows of `length` consecutive ranks (3..Ace) where
 * every rank has at least `unitSize` non-bomb cards available. */
function sequenceWindows(groups: readonly Group[], unitSize: number, length: number): SequenceCandidate[] {
  const countAt = new Map<number, number>();
  for (const g of groups) {
    // A bombed rank contributes 0 usable copies to a sequence: the sequence
    // must route around it rather than crack the bomb open.
    countAt.set(g.rank, g.cards.length >= 4 ? 0 : g.cards.length);
  }
  const results: SequenceCandidate[] = [];
  for (let start = 3; start + length - 1 <= MAX_SEQUENCE_RANK; start++) {
    let tier = 0;
    let ok = true;
    for (let r = start; r < start + length; r++) {
      const count = countAt.get(r) ?? 0;
      if (count < unitSize) {
        ok = false;
        break;
      }
      tier += breakTier(count, unitSize);
    }
    if (ok) results.push({ startRank: start, length, tier });
  }
  return results;
}

function windowCards(groups: readonly Group[], unitSize: number, startRank: number, length: number): Card[] {
  const byRank = new Map<number, readonly Card[]>(groups.map((g) => [g.rank, g.cards]));
  const cards: Card[] = [];
  for (let r = startRank; r < startRank + length; r++) {
    const groupCards = byRank.get(r);
    if (!groupCards) throw new Error(`suggestPlay: internal error, no cards at rank ${r}`);
    cards.push(...groupCards.slice(0, unitSize));
  }
  return cards;
}

/** Cheapest sequence window (fewest breaks, then lowest start rank) strictly
 * above `minRankExclusive`, or null if none exists at this exact length. */
function bestSequence(
  groups: readonly Group[],
  unitSize: number,
  length: number,
  minRankExclusive: number,
): SequenceCandidate | null {
  const windows = sequenceWindows(groups, unitSize, length).filter((w) => w.startRank > minRankExclusive);
  windows.sort((a, b) => a.tier - b.tier || a.startRank - b.startRank);
  return windows[0] ?? null;
}

function ranksInWindow(startRank: number, length: number): Set<Rank> {
  const set = new Set<Rank>();
  for (let r = startRank; r < startRank + length; r++) set.add(r as Rank);
  return set;
}

// --- category dispatch -------------------------------------------------------

/**
 * Find the cheapest hand selection classifying as `category`/`length` with
 * mainRank strictly greater than `minRankExclusive` (ignored for "bomb",
 * where any bomb qualifies — the caller enforces the bigger-bomb rule when
 * `previous` is itself a bomb). Returns null if no such selection exists.
 */
function bestForCategory(
  hand: readonly Card[],
  category: ComboCategory,
  length: number,
  minRankExclusive: number,
): Card[] | null {
  const groups = groupByRank(hand);

  switch (category) {
    case "single": {
      const unit = bestUnit(groups, 1, minRankExclusive);
      return unit && unit.cards;
    }
    case "pair": {
      const unit = bestUnit(groups, 2, minRankExclusive);
      return unit && unit.cards;
    }
    case "triple": {
      const unit = bestUnit(groups, 3, minRankExclusive);
      return unit && unit.cards;
    }
    case "bomb": {
      const bombGroups = groups.filter((g) => g.cards.length === 4 && g.rank > minRankExclusive);
      bombGroups.sort((a, b) => a.rank - b.rank);
      const g = bombGroups[0];
      return g ? g.cards.slice() : null;
    }
    case "straight":
    case "pairStraight":
    case "plane": {
      const unitSize = category === "straight" ? 1 : category === "pairStraight" ? 2 : 3;
      const win = bestSequence(groups, unitSize, length, minRankExclusive);
      return win && windowCards(groups, unitSize, win.startRank, win.length);
    }
    case "triplePlusSingle":
    case "triplePlusPair":
    case "planePlusSingles":
    case "planePlusPairs": {
      const kickerUnitSize = category === "triplePlusSingle" || category === "planePlusSingles" ? 1 : 2;
      // Try candidate plane windows cheapest-first until one has enough kickers.
      const windows = sequenceWindows(groups, 3, length)
        .filter((w) => w.startRank > minRankExclusive)
        .sort((a, b) => a.tier - b.tier || a.startRank - b.startRank);
      for (const win of windows) {
        const exclude = ranksInWindow(win.startRank, win.length);
        const kickers = bestKickers(groups, kickerUnitSize, length, exclude);
        if (kickers) {
          return [...windowCards(groups, 3, win.startRank, win.length), ...kickers];
        }
      }
      return null;
    }
    case "fourPlusTwoSingles":
    case "fourPlusTwoPairs": {
      const kickerUnitSize = category === "fourPlusTwoSingles" ? 1 : 2;
      const quadGroups = groups.filter((g) => g.cards.length === 4 && g.rank > minRankExclusive);
      quadGroups.sort((a, b) => a.rank - b.rank);
      for (const quad of quadGroups) {
        const kickers = bestKickers(groups, kickerUnitSize, 2, new Set([quad.rank]));
        if (kickers) return [...quad.cards, ...kickers];
      }
      return null;
    }
    case "rocket":
      return bestRocket(hand);
    default:
      return null;
  }
}

function bestRocket(hand: readonly Card[]): Card[] | null {
  const black = hand.find((c) => c.rank === RANK.BlackJoker);
  const red = hand.find((c) => c.rank === RANK.RedJoker);
  return black && red ? [black, red] : null;
}

// --- public API ---------------------------------------------------------------

/**
 * Suggest which cards from `hand` to play.
 *
 * - `lastPlay === null` (leading a fresh trick): always returns a play (a
 *   lead can always be made from a non-empty hand). Sheds the longest safe
 *   straight/pair-straight/plane if one exists, otherwise the lowest single
 *   or pair that isn't part of a triple/bomb, otherwise falls back through
 *   triples and finally bombs/rocket. If the whole hand is itself one legal
 *   combo, always suggests it (instant win).
 * - `lastPlay !== null` (must beat it): returns the cheapest same-category
 *   response, falling back to a bomb/rocket only when no same-category
 *   response exists (never breaking a bomb apart for a lesser combo), or
 *   null if nothing in hand beats it.
 *
 * Deterministic: same inputs always produce the same output.
 */
export function suggestPlay(hand: readonly Card[], lastPlay: Combo | null, opts: SuggestPlayOptions = {}): Card[] | null {
  if (hand.length === 0) return null;
  const allowBombs = opts.allowBombs ?? true;

  if (lastPlay === null) return suggestLead(hand, allowBombs);
  return suggestBeat(hand, lastPlay, allowBombs);
}

function suggestBeat(hand: readonly Card[], lastPlay: Combo, allowBombs: boolean): Card[] | null {
  if (lastPlay.category === "rocket") return null;

  if (lastPlay.category !== "bomb") {
    const sameCategory = bestForCategory(hand, lastPlay.category, lastPlay.length, lastPlay.mainRank);
    if (sameCategory) return sameCategory;
  }

  if (!allowBombs) return null;

  const bombMinRank = lastPlay.category === "bomb" ? lastPlay.mainRank : 0;
  const bomb = bestForCategory(hand, "bomb", 1, bombMinRank);
  if (bomb) return bomb;

  return bestRocket(hand);
}

function suggestLead(hand: readonly Card[], allowBombs: boolean): Card[] {
  // Instant win: the whole hand is itself one legal combo.
  const whole = classifyCombo(hand);
  if (whole) return hand.slice();

  const groups = groupByRank(hand);

  // Longest safe sequence (straight > pairStraight > plane on a tie).
  const sequenceLead = bestLeadSequence(groups);
  if (sequenceLead) return sequenceLead;

  // Lowest single/pair drawn only from loose (non-triple, non-bomb) ranks.
  const safeUnit = bestLeadUnit(groups, [1, 2]);
  if (safeUnit) return safeUnit;

  // Fall back to a bare triple (fully consumed, not a break).
  const tripleUnit = bestLeadUnit(groups, [3]);
  if (tripleUnit) return tripleUnit;

  // Nothing loose left: hand is bombs (and/or a lone unpaired joker already
  // covered above). A lead must always return a play.
  if (allowBombs) {
    const bomb = bestForCategory(hand, "bomb", 1, 0);
    if (bomb) return bomb;
    const rocket = bestRocket(hand);
    if (rocket) return rocket;
  }

  // Last resort: any single card (even out of a bomb) so a play is always
  // returned. Only reachable when allowBombs is false and hand is all bombs.
  return [hand[0]];
}

function bestLeadUnit(groups: readonly Group[], unitSizes: readonly number[]): Card[] | null {
  let best: UnitCandidate | null = null;
  for (const size of unitSizes) {
    for (const g of nonBombGroups(groups)) {
      if (g.cards.length !== size) continue;
      if (best === null || g.rank < best.mainRank) {
        best = { cards: g.cards.slice(0, size), mainRank: g.rank, tier: 0 };
      }
    }
  }
  return best && best.cards;
}

/**
 * Strict category precedence, straight > pairStraight > plane, matching the
 * order named in the spec: the first category with any qualifying *safe*
 * window wins, using its longest available window (lowest start rank on a
 * tie). "Safe" means tier 0 only — e.g. a bare plane's triples must never
 * get counted as pair-straight material by partially breaking them apart;
 * a lead only ever sheds material that's already exactly shaped that way.
 */
function bestLeadSequence(groups: readonly Group[]): Card[] | null {
  const options: { unitSize: number; minLength: number }[] = [
    { unitSize: 1, minLength: 5 }, // straight
    { unitSize: 2, minLength: 3 }, // pairStraight
    { unitSize: 3, minLength: 2 }, // plane
  ];

  for (const { unitSize, minLength } of options) {
    let maxLength = 0;
    for (let length = minLength; length <= 12; length++) {
      const safe = sequenceWindows(groups, unitSize, length).some((w) => w.tier === 0);
      if (safe) maxLength = length;
    }
    if (maxLength === 0) continue;
    const windows = sequenceWindows(groups, unitSize, maxLength)
      .filter((w) => w.tier === 0)
      .sort((a, b) => a.startRank - b.startRank);
    const win = windows[0];
    return windowCards(groups, unitSize, win.startRank, win.length);
  }

  return null;
}
