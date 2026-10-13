import { describe, expect, it } from "vitest";
import { cardPoints, createDeck, createSeededRandom, shuffleDeck, sortHand, DECK_SIZE } from "../src/cards";
import { cardsOf } from "./helpers";

describe("createDeck", () => {
  it("builds the 108-card UNO deck with unique ids", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(DECK_SIZE);
    expect(new Set(deck.map((c) => c.id)).size).toBe(DECK_SIZE);
  });

  it("holds one 0, two of each 1-9, and two of each action per colour, plus four of each wild", () => {
    const deck = createDeck();
    for (const color of ["red", "yellow", "green", "blue"] as const) {
      const ofColor = deck.filter((c) => c.color === color);
      expect(ofColor).toHaveLength(25);
      expect(ofColor.filter((c) => c.kind === "number" && c.value === 0)).toHaveLength(1);
      for (let v = 1; v <= 9; v++) {
        expect(ofColor.filter((c) => c.kind === "number" && c.value === v)).toHaveLength(2);
      }
      expect(ofColor.filter((c) => c.kind === "skip")).toHaveLength(2);
      expect(ofColor.filter((c) => c.kind === "reverse")).toHaveLength(2);
      expect(ofColor.filter((c) => c.kind === "draw2")).toHaveLength(2);
    }
    expect(deck.filter((c) => c.kind === "wild")).toHaveLength(4);
    expect(deck.filter((c) => c.kind === "wild4")).toHaveLength(4);
    expect(deck.filter((c) => c.color === null)).toHaveLength(8);
  });
});

describe("shuffleDeck", () => {
  it("is a permutation, deterministic per seed, and leaves the input untouched", () => {
    const deck = createDeck();
    const a = shuffleDeck(deck, createSeededRandom(7));
    const b = shuffleDeck(deck, createSeededRandom(7));
    expect(a).toEqual(b);
    expect(a).not.toEqual(deck);
    expect(deck).toEqual(createDeck());
    expect([...a].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [...deck].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });
});

describe("cardPoints", () => {
  it("scores numbers at face value, actions at 20, wilds at 50", () => {
    const [r0, g7, bS, yR, rD, w, w4] = cardsOf(["r0", "g7a", "bSa", "yRb", "rDa", "Wa", "W4d"]);
    expect(cardPoints(r0)).toBe(0);
    expect(cardPoints(g7)).toBe(7);
    expect(cardPoints(bS)).toBe(20);
    expect(cardPoints(yR)).toBe(20);
    expect(cardPoints(rD)).toBe(20);
    expect(cardPoints(w)).toBe(50);
    expect(cardPoints(w4)).toBe(50);
  });
});

describe("sortHand", () => {
  it("groups by colour, numbers ascending before actions, wilds last", () => {
    const sorted = sortHand(cardsOf(["W4a", "b3a", "r9a", "rSa", "Wa", "r2b", "g0"]));
    expect(sorted.map((c) => c.id)).toEqual(["r2b", "r9a", "rSa", "g0", "b3a", "Wa", "W4a"]);
  });
});
