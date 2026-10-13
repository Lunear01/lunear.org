import { describe, expect, it } from "vitest";
import { cardMultiplier, settle, type FinishedState } from "../src/game";
import { cardsOf } from "./helpers";

function finished(handsLeft: Partial<Record<0 | 1 | 2 | 3, number>>, winner: 0 | 1 | 2 | 3, baseStake = 10): FinishedState {
  const deck = cardsOf(["3D", "4D", "5D", "6D", "7D", "8D", "9D", "10D", "JD", "QD", "KD", "AD", "2D"]);
  const activeSeats = ([0, 1, 2, 3] as const).filter((s) => s === winner || handsLeft[s] !== undefined);
  return {
    phase: "finished",
    activeSeats,
    baseStake,
    winner,
    hands: {
      0: deck.slice(0, handsLeft[0] ?? 0),
      1: deck.slice(0, handsLeft[1] ?? 0),
      2: deck.slice(0, handsLeft[2] ?? 0),
      3: deck.slice(0, handsLeft[3] ?? 0),
    },
    history: [],
  };
}

describe("cardMultiplier", () => {
  it("is 1 up to 9 cards, 2 for 10-12, 3 for 13", () => {
    expect(cardMultiplier(1)).toBe(1);
    expect(cardMultiplier(9)).toBe(1);
    expect(cardMultiplier(10)).toBe(2);
    expect(cardMultiplier(12)).toBe(2);
    expect(cardMultiplier(13)).toBe(3);
  });
});

describe("settle", () => {
  it("charges each loser cards × multiplier × stake and pays the winner the sum", () => {
    const deltas = settle(finished({ 1: 3, 2: 10, 3: 13 }, 0, 10));
    expect(deltas).toEqual({ 0: 30 + 200 + 390, 1: -30, 2: -200, 3: -390 });
  });

  it("sums to zero and leaves inactive seats at zero", () => {
    const deltas = settle(finished({ 2: 5 }, 0, 7));
    expect(deltas).toEqual({ 0: 35, 1: 0, 2: -35, 3: 0 });
    expect(Object.values(deltas).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("reads the stake from state", () => {
    expect(settle(finished({ 1: 1 }, 0, 250))).toEqual({ 0: 250, 1: -250, 2: 0, 3: 0 });
  });
});
