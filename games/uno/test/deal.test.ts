import { describe, expect, it } from "vitest";
import { createDeck, createSeededRandom, shuffleDeck } from "../src/cards";
import { createGame } from "../src/game";
import { buildDeck, ids, newGame } from "./helpers";

const HANDS = {
  0: ["r1a", "r2a", "r3a", "r4a", "r5a", "r6a", "r7a"],
  1: ["b1a", "b2a", "b3a", "b4a", "b5a", "b6a", "b7a"],
} as const;

describe("createGame", () => {
  it("deals 7 cards per active seat in seat order and flips a number card", () => {
    const state = newGame({ hands: HANDS, flips: ["g5a"], draws: ["y9a"] });
    expect(ids(state.hands[0])).toEqual([...HANDS[0]]);
    expect(ids(state.hands[1])).toEqual([...HANDS[1]]);
    expect(state.hands[2]).toEqual([]);
    expect(state.discardPile.map((c) => c.id)).toEqual(["g5a"]);
    expect(state.currentColor).toBe("green");
    expect(state.currentTurn).toBe(0);
    expect(state.direction).toBe(1);
    expect(state.pendingDraw).toBeNull();
    expect(state.drawPile).toHaveLength(108 - 14 - 1);
    expect(state.drawPile[state.drawPile.length - 1].id).toBe("y9a");
  });

  it("keeps flipping past action and wild cards, which go to the bottom of the draw pile", () => {
    const state = newGame({ hands: HANDS, flips: ["W4a", "rSa", "Wb", "g5a"], draws: ["y9a"] });
    expect(state.discardPile.map((c) => c.id)).toEqual(["g5a"]);
    expect(state.drawPile.slice(0, 3).map((c) => c.id)).toEqual(["Wb", "rSa", "W4a"]);
    expect(state.drawPile[state.drawPile.length - 1].id).toBe("y9a");
    expect(state.drawPile).toHaveLength(108 - 14 - 1);
  });

  it("accepts any seat subset from 2 to 6 and starts on firstSeat", () => {
    const deck = shuffleDeck(createDeck(), createSeededRandom(3));
    const state = createGame({ shuffledDeck: deck, activeSeats: [5, 1, 3], firstSeat: 3, baseStake: 50 });
    expect(state.activeSeats).toEqual([1, 3, 5]);
    expect(state.currentTurn).toBe(3);
    for (const seat of [1, 3, 5] as const) expect(state.hands[seat]).toHaveLength(7);
    for (const seat of [0, 2, 4] as const) expect(state.hands[seat]).toEqual([]);
    expect(state.baseStake).toBe(50);
    expect(state.discardPile[0].kind).toBe("number");
  });

  it("rejects a bad seat set, a firstSeat outside it, or a short deck", () => {
    const deck = buildDeck({ hands: HANDS, flips: ["g5a"] });
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0, 0], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0, 1], firstSeat: 2, baseStake: 1 })).toThrow();
    expect(() =>
      createGame({ shuffledDeck: deck.slice(1), activeSeats: [0, 1], firstSeat: 0, baseStake: 1 }),
    ).toThrow();
  });
});
