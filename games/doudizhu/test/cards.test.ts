import { describe, expect, it } from "vitest";
import { RANK, createDeck, createSeededRandom, shuffleDeck, sortHand } from "../src/cards";

describe("createDeck", () => {
  it("has exactly 54 unique cards", () => {
    const deck = createDeck();
    expect(deck.length).toBe(54);
    expect(new Set(deck.map((c) => c.id)).size).toBe(54);
  });

  it("has 4 of each of the 13 ordinary ranks plus one of each joker", () => {
    const deck = createDeck();
    const counts = new Map<number, number>();
    for (const card of deck) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    for (const rank of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(counts.get(rank)).toBe(4);
    }
    expect(counts.get(RANK.BlackJoker)).toBe(1);
    expect(counts.get(RANK.RedJoker)).toBe(1);
  });
});

describe("rank ordering", () => {
  it("orders 3 < 4 < ... < K < A < 2 < blackJoker < redJoker", () => {
    expect(RANK.Three).toBeLessThan(RANK.Four);
    expect(RANK.King).toBeLessThan(RANK.Ace);
    expect(RANK.Ace).toBeLessThan(RANK.Two);
    expect(RANK.Two).toBeLessThan(RANK.BlackJoker);
    expect(RANK.BlackJoker).toBeLessThan(RANK.RedJoker);
  });
});

describe("shuffleDeck", () => {
  it("is a pure permutation: same cards, does not mutate the input", () => {
    const deck = createDeck();
    const random = createSeededRandom(42);
    const shuffled = shuffleDeck(deck, random);
    expect(shuffled).not.toBe(deck);
    expect(shuffled.length).toBe(54);
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

describe("sortHand", () => {
  it("sorts by rank ascending", () => {
    const deck = createDeck();
    const hand = [deck.find((c) => c.id === "AS")!, deck.find((c) => c.id === "3H")!, deck.find((c) => c.id === "RJ")!];
    const sorted = sortHand(hand);
    expect(sorted.map((c) => c.id)).toEqual(["3H", "AS", "RJ"]);
  });
});
