import { describe, expect, it } from "vitest";
import { createGame, settle, type FinishedState } from "../src/game";
import { act, buildShoe } from "./helpers";

function playedOut(stake: number): FinishedState {
  // Seat 0 natural (+3:2), seat 1 doubles to 21 (+2x), seat 2 busts (-1x),
  // seat 3 pushes the dealer's 18, seat 4 stands under it (-1x).
  const shoe = buildShoe([0, 1, 2, 3, 4], {
    hands: {
      0: ["Ac", "Kc"],
      1: ["6c", "5c"],
      2: ["Tc", "9c"],
      3: ["Th", "8h"],
      4: ["Td", "7d"],
    },
    dealer: ["Ts", "8s"],
    draws: ["Th", "5d"], // seat 1's double card (21), seat 2's bust card
  });
  let state = createGame({ seats: [0, 1, 2, 3, 4], stake, shuffledShoe: shoe });
  if (state.phase !== "acting") throw new Error("expected acting");
  state = act(state, 1, { type: "double" });
  state = act(state, 2, { type: "hit" });
  if (state.phase !== "acting") throw new Error("expected acting");
  state = act(state, 3, { type: "stand" });
  const end = act(state, 4, { type: "stand" });
  if (end.phase !== "finished") throw new Error("expected finished");
  return end;
}

describe("settle", () => {
  it("pays each outcome against the house", () => {
    const end = playedOut(100);
    expect(end.outcomes).toEqual({ 0: "blackjack", 1: "win", 2: "lose", 3: "push", 4: "lose" });
    expect(settle(end)).toEqual({ 0: 150, 1: 200, 2: -100, 3: 0, 4: -100 });
  });

  it("floors the 3:2 natural payout on an odd stake", () => {
    const end = playedOut(25);
    expect(settle(end)[0]).toBe(37); // floor(1.5 x 25)
    expect(settle(end)[1]).toBe(50); // doubled bet
  });

  it("is deliberately not zero-sum — the house absorbs the balance", () => {
    const deltas = settle(playedOut(100));
    const sum = Object.values(deltas).reduce((a, b) => a + b, 0);
    expect(sum).toBe(150);
  });
});
