import { describe, expect, it } from "vitest";
import { createSeededRandom, createShoe, shuffleCards, SHOE_DECKS } from "../src/cards";

describe("createShoe", () => {
  it("builds the default 6-deck shoe with unique ids", () => {
    const shoe = createShoe();
    expect(SHOE_DECKS).toBe(6);
    expect(shoe).toHaveLength(312);
    expect(new Set(shoe.map((c) => c.id)).size).toBe(312);
  });

  it("holds exactly `decks` copies of each rank/suit", () => {
    const shoe = createShoe(3);
    expect(shoe).toHaveLength(156);
    const aces = shoe.filter((c) => c.rank === 14 && c.suit === "s");
    expect(aces).toHaveLength(3);
  });
});

describe("shuffleCards", () => {
  it("permutes without mutating the input", () => {
    const shoe = createShoe(1);
    const before = shoe.map((c) => c.id);
    const shuffled = shuffleCards(shoe, createSeededRandom(7));
    expect(shoe.map((c) => c.id)).toEqual(before);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(52);
  });

  it("is deterministic for a fixed seed", () => {
    const shoe = createShoe(1);
    const a = shuffleCards(shoe, createSeededRandom(42)).map((c) => c.id);
    const b = shuffleCards(shoe, createSeededRandom(42)).map((c) => c.id);
    expect(a).toEqual(b);
  });
});
