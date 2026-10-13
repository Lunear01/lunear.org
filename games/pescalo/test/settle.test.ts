import { describe, expect, it } from "vitest";
import { settle, type FinishedState } from "../src/game";

function finished(activeSeats: FinishedState["activeSeats"], books: Partial<Record<0 | 1 | 2 | 3 | 4, number[]>>): FinishedState {
  const full = { 0: [], 1: [], 2: [], 3: [], 4: [], ...books } as FinishedState["books"];
  const most = Math.max(...activeSeats.map((s) => full[s].length));
  return {
    phase: "finished",
    activeSeats,
    baseStake: 10,
    books: full,
    winners: activeSeats.filter((s) => full[s].length === most),
    lastEvents: [],
  };
}

describe("settle", () => {
  it("pays one stake per book of difference against every other seat", () => {
    const deltas = settle(finished([0, 1], { 0: [3, 4, 5, 6, 7, 8, 9, 10], 1: [11, 12, 13, 14, 15] }));
    // 2 players: 8 vs 5 books, difference 3 → 30 credits change hands.
    expect(deltas).toEqual({ 0: 30, 1: -30, 2: 0, 3: 0, 4: 0 });
  });

  it("is zero-sum at any seat count and settles inactive seats at 0", () => {
    const deltas = settle(finished([0, 2, 3], { 0: [3, 4, 5, 6, 7, 8], 2: [9, 10, 11, 12], 3: [13, 14, 15] }));
    expect(deltas).toEqual({ 0: 10 * (3 * 6 - 13), 1: 0, 2: 10 * (3 * 4 - 13), 3: 10 * (3 * 3 - 13), 4: 0 });
    expect(Object.values(deltas).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("leaves a tie between all seats at zero", () => {
    // Five seats can't split 13 books evenly; two seats at 6 and 7 is the closest, not a tie.
    const deltas = settle(finished([0, 1], { 0: [3, 4, 5, 6, 7, 8], 1: [9, 10, 11, 12, 13, 14, 15] }));
    expect(deltas).toEqual({ 0: -10, 1: 10, 2: 0, 3: 0, 4: 0 });
  });
});
