// Card model for Liar's Bar (Liar's Deck ruleset). Unlike Dou Dizhu, no card
// ordering/strength comparison exists here — the only thing that ever matters
// about a card is whether it equals the table rank or is a wild joker. So,
// unlike doudizhu's cards.ts, there is no numeric RANK map and no sortHand:
// hand order carries no rules meaning in this game.
export type Rank = "Q" | "K" | "A" | "JOKER";

/** The three ranks a round's table rank can be; jokers are never the table rank. */
export type TableRank = "Q" | "K" | "A";

export interface Card {
  readonly id: string;
  readonly rank: Rank;
}

const TABLE_RANKS: readonly TableRank[] = ["Q", "K", "A"];
const COPIES_PER_RANK = 6;

/** Fixed-order 20-card deck (6 Q + 6 K + 6 A + 2 Jokers). Caller shuffles. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const rank of TABLE_RANKS) {
    for (let copy = 1; copy <= COPIES_PER_RANK; copy++) {
      deck.push({ id: `${rank}${copy}`, rank });
    }
  }
  deck.push({ id: "JOKER1", rank: "JOKER" });
  deck.push({ id: "JOKER2", rank: "JOKER" });
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
 * that need reproducible shuffles/rolls (tests, replay). The engine itself
 * never calls this internally — every entry point takes a deck, table rank,
 * and bullet positions as plain inputs.
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

/** Caller-side convenience: pick a uniformly random table rank. Never called by the engine itself. */
export function pickTableRank(random: RandomSource): TableRank {
  return TABLE_RANKS[Math.floor(random() * TABLE_RANKS.length)];
}

/** Caller-side convenience: roll a uniformly random 1-6 bullet chamber position. Never called by the engine itself. */
export function rollBulletChamber(random: RandomSource): number {
  return 1 + Math.floor(random() * 6);
}
