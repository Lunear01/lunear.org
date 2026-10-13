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
  it("orders 3D lowest and 2S highest", () => {
    const deck = createDeck();
    const sorted = sortHand(deck);
    expect(sorted[0].id).toBe("3D");
    expect(sorted[51].id).toBe("2S");
  });

  it("ranks by rank first, then suit D<C<H<S", () => {
    const [threeS, fourD, threeH, threeC] = cardsOf(["3S", "4D", "3H", "3C"]);
    expect(compareCards(threeS, fourD)).toBeLessThan(0);
    expect(compareCards(threeC, threeH)).toBeLessThan(0);
    expect(compareCards(threeH, threeS)).toBeLessThan(0);
    expect(cardValue(threeS)).toBeGreaterThan(cardValue(threeH));
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
