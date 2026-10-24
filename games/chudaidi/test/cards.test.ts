import { describe, expect, it } from "vitest";
import { cardValue, compareCards, createDeck, createSeededRandom, shuffleDeck, sortHand } from "../src/cards";
import { cardsOf } from "./helpers";

describe("createDeck", () => {
  it("builds 52 unique cards, 13 per suit", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
    for (const suit of ["D", "C", "H", "S"]) {
      expect(deck.filter((c) => c.suit === suit)).toHaveLength(13);
    }
  });

  it("has no jokers and ranks 3..15 only", () => {
    const ranks = new Set(createDeck().map((c) => c.rank));
    expect([...ranks].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe("card order", () => {
  it("orders 4D lowest and 3S highest", () => {
    const deck = createDeck();
    const sorted = sortHand(deck);
    expect(sorted[0].id).toBe("4D");
    expect(sorted[1].id).toBe("4C");
    expect(sorted[50].id).toBe("3H");
    expect(sorted[51].id).toBe("3S");
  });

  it("ranks 4 < 5 < ... < A < 2 < 3, then suit D<C<H<S", () => {
    const [fourS, fiveD, twoS, threeD, threeH, threeC, aceS] = cardsOf(["4S", "5D", "2S", "3D", "3H", "3C", "AS"]);
    expect(compareCards(fourS, fiveD)).toBeLessThan(0);
    expect(compareCards(aceS, twoS)).toBeLessThan(0);
    expect(compareCards(twoS, threeD)).toBeLessThan(0);
    expect(compareCards(threeC, threeH)).toBeLessThan(0);
    expect(cardValue(threeH)).toBeGreaterThan(cardValue(threeC));
  });
});

describe("shuffleDeck", () => {
  it("is a permutation and leaves the input alone", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, createSeededRandom(7));
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(52);
    expect(deck.map((c) => c.id)).toEqual(createDeck().map((c) => c.id));
  });

  it("is reproducible from the same seed", () => {
    const a = shuffleDeck(createDeck(), createSeededRandom(42)).map((c) => c.id);
    const b = shuffleDeck(createDeck(), createSeededRandom(42)).map((c) => c.id);
    expect(a).toEqual(b);
  });
});
