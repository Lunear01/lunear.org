import { describe, expect, it } from "vitest";
import {
  createDeck,
  createSeededRandom,
  pickTableRank,
  rollBulletChamber,
  shuffleDeck,
} from "../src/cards";

describe("createDeck", () => {
  it("has exactly 20 unique cards", () => {
    const deck = createDeck();
    expect(deck.length).toBe(20);
    expect(new Set(deck.map((c) => c.id)).size).toBe(20);
  });

  it("has 6 Queens, 6 Kings, 6 Aces, and 2 Jokers", () => {
    const deck = createDeck();
    const counts = new Map<string, number>();
    for (const card of deck) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    expect(counts.get("Q")).toBe(6);
    expect(counts.get("K")).toBe(6);
    expect(counts.get("A")).toBe(6);
    expect(counts.get("JOKER")).toBe(2);
  });
});

describe("shuffleDeck", () => {
  it("is a pure permutation: same cards, does not mutate the input", () => {
    const deck = createDeck();
    const random = createSeededRandom(42);
    const shuffled = shuffleDeck(deck, random);
    expect(shuffled).not.toBe(deck);
    expect(shuffled.length).toBe(20);
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

describe("pickTableRank", () => {
  it("always returns one of Q/K/A and is deterministic for a given seed", () => {
    for (let seed = 0; seed < 50; seed++) {
      const rank = pickTableRank(createSeededRandom(seed));
      expect(["Q", "K", "A"]).toContain(rank);
      expect(pickTableRank(createSeededRandom(seed))).toBe(rank);
    }
  });
});

describe("rollBulletChamber", () => {
  it("always returns an integer in 1..6 and is deterministic for a given seed", () => {
    for (let seed = 0; seed < 50; seed++) {
      const chamber = rollBulletChamber(createSeededRandom(seed));
      expect(Number.isInteger(chamber)).toBe(true);
      expect(chamber).toBeGreaterThanOrEqual(1);
      expect(chamber).toBeLessThanOrEqual(6);
      expect(rollBulletChamber(createSeededRandom(seed))).toBe(chamber);
    }
  });
});
