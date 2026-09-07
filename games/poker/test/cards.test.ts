import { describe, expect, it } from "vitest";
import { RANK, createDeck, createSeededRandom, shuffleDeck } from "../src/cards";

describe("createDeck", () => {
  it("has exactly 52 unique cards", () => {
    const deck = createDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
  });

  it("has 4 of each of the 13 ranks, one per suit", () => {
    const deck = createDeck();
    const counts = new Map<number, number>();
    for (const card of deck) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    for (const rank of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      expect(counts.get(rank)).toBe(4);
    }
    const suitsByRank = new Map<number, Set<string>>();
    for (const card of deck) {
      const set = suitsByRank.get(card.rank) ?? new Set<string>();
      set.add(card.suit);
      suitsByRank.set(card.rank, set);
    }
    for (const [, suits] of suitsByRank) expect(suits).toEqual(new Set(["c", "d", "h", "s"]));
  });
});

describe("rank ordering", () => {
  it("orders 2 < 3 < ... < K < A", () => {
    expect(RANK.Two).toBeLessThan(RANK.Three);
    expect(RANK.King).toBeLessThan(RANK.Ace);
    expect(RANK.Ace).toBe(14);
  });
});

describe("shuffleDeck", () => {
  it("is a pure permutation: same cards, does not mutate the input", () => {
    const deck = createDeck();
    const random = createSeededRandom(42);
    const shuffled = shuffleDeck(deck, random);
    expect(shuffled).not.toBe(deck);
    expect(shuffled.length).toBe(52);
    expect(new Set(shuffled.map((c) => c.id))).toEqual(new Set(deck.map((c) => c.id)));
    expect(deck.map((c) => c.id)).toEqual(createDeck().map((c) => c.id)); // untouched
  });

  it("is deterministic for a given seed", () => {
    const deck = createDeck();
    const a = shuffleDeck(deck, createSeededRandom(7));
    const b = shuffleDeck(deck, createSeededRandom(7));
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it("different seeds produce different orders", () => {
    const deck = createDeck();
    const a = shuffleDeck(deck, createSeededRandom(1));
    const b = shuffleDeck(deck, createSeededRandom(2));
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id));
  });
});
