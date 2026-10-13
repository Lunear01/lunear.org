import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import { createGame, handSizeFor } from "../src/game";
import { game, ids, playing } from "./helpers";

describe("createGame", () => {
  it("deals 7 each at two seats and pools the rest", () => {
    const state = playing(game([0, 1], {}));
    expect(state.hands[0]).toHaveLength(7);
    expect(state.hands[1]).toHaveLength(7);
    expect(state.hands[2]).toEqual([]);
    expect(state.pool).toHaveLength(52 - 14);
    expect(state.currentTurn).toBe(0);
    expect(state.books).toEqual({ 0: [], 1: [], 2: [], 3: [], 4: [] });
  });

  it("deals 5 each at three or more seats", () => {
    expect(handSizeFor(3)).toBe(5);
    const state = playing(game([0, 2, 4], {}, [], 2));
    expect(state.activeSeats).toEqual([0, 2, 4]);
    for (const seat of [0, 2, 4] as const) expect(state.hands[seat]).toHaveLength(5);
    expect(state.hands[1]).toEqual([]);
    expect(state.pool).toHaveLength(52 - 15);
    expect(state.currentTurn).toBe(2);
  });

  it("draws from the named pool top first", () => {
    const state = playing(game([0, 1], {}, ["QS", "QH"]));
    expect(state.pool[state.pool.length - 1].id).toBe("QS");
    expect(state.pool[state.pool.length - 2].id).toBe("QH");
  });

  it("lays down a book dealt outright", () => {
    const state = playing(game([0, 1, 2], { 0: ["7S", "7H", "7D", "7C", "3S"] }));
    expect(ids(state.hands[0])).toEqual(["3S"]);
    expect(state.books[0]).toEqual([7]);
    expect(state.lastEvents).toEqual([{ type: "book", seat: 0, rank: 7 }]);
  });

  it("rejects bad decks, seat lists and first seats", () => {
    const deck = createDeck();
    expect(() => createGame({ shuffledDeck: deck.slice(1), activeSeats: [0, 1], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: [deck[0], ...deck.slice(2), deck[0]], activeSeats: [0, 1], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0, 0], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0, 1, 2, 3, 4, 5 as 0], firstSeat: 0, baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: deck, activeSeats: [0, 1], firstSeat: 2, baseStake: 1 })).toThrow();
  });
});
