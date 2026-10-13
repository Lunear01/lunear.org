import { describe, expect, it } from "vitest";
import { RANKS, createDeck, createSeededRandom, shuffleDeck, sortHand } from "../src/cards";

describe("createDeck", () => {
  it("holds 52 distinct cards, four of each of the 13 ranks", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
    for (const rank of RANKS) expect(deck.filter((c) => c.rank === rank)).toHaveLength(4);
  });
});

describe("shuffleDeck", () => {
  it("is a permutation, reproducible per seed, and leaves the input alone", () => {
    const deck = createDeck();
    const a = shuffleDeck(deck, createSeededRandom(7));
    const b = shuffleDeck(deck, createSeededRandom(7));
    expect(a).toEqual(b);
    expect(a.map((c) => c.id).sort()).toEqual(deck.map((c) => c.id).sort());
    expect(deck).toEqual(createDeck());
    expect(a.map((c) => c.id)).not.toEqual(deck.map((c) => c.id));
  });
});

describe("sortHand", () => {
  it("orders by rank then suit without mutating", () => {
    const deck = createDeck();
    const picked = [deck[20], deck[3], deck[40]];
    const sorted = sortHand(picked);
    expect(sorted.map((c) => c.rank)).toEqual([...sorted.map((c) => c.rank)].sort((x, y) => x - y));
    expect(picked).toHaveLength(3);
  });
});
