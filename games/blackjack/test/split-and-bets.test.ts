import { describe, expect, it } from "vitest";
import { canSplit, createGame, settle, viewFor, type ActingState, type FinishedState } from "../src/game";
import { act, buildShoe, expectRejected, labelsOf } from "./helpers";

function acting(state: ReturnType<typeof createGame>): ActingState {
  if (state.phase !== "acting") throw new Error(`expected acting state, got ${state.phase}`);
  return state;
}

function finished(state: ReturnType<typeof createGame>): FinishedState {
  if (state.phase !== "finished") throw new Error(`expected finished state, got ${state.phase}`);
  return state;
}

describe("split", () => {
  it("splits a pair into two hands, each with its own bet, played left to right", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["8c", "8d"], 1: ["Tc", "7c"] },
      dealer: ["Ts", "7s"],
      draws: ["3h", "2h", "Th", "9h"], // split draws 3h/2h; hand 1 hits Th (21), hand 2 hits 9h (19)
    });
    let state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    expect(canSplit(state.players[0])).toBe(true);
    expect(viewFor(state, 1).players[0].canSplit).toBe(true);

    state = acting(act(state, 0, { type: "split" }));
    expect(state.players[0].hands).toHaveLength(2);
    expect(labelsOf(state.players[0].hands[0].cards)).toEqual(["8c", "3h"]);
    expect(labelsOf(state.players[0].hands[1].cards)).toEqual(["8d", "2h"]);
    expect(state.players[0].hands.map((h) => h.bet)).toEqual([100, 100]);
    expect(state.players[0].hands.every((h) => h.fromSplit)).toBe(true);
    expect(state.players[0].activeHand).toBe(0);
    expect(state.currentTurn).toBe(0);
    expect(viewFor(state, 0).players[0].totalBet).toBe(200);
    expectRejected(state, 0, { type: "split" }, "cannot-split");

    state = acting(act(state, 0, { type: "hit" })); // 11 -> 21, first hand done
    expect(state.players[0].hands[0].done).toBe(true);
    expect(state.players[0].activeHand).toBe(1);
    expect(state.currentTurn).toBe(0);

    state = acting(act(state, 0, { type: "hit" })); // 10 -> 19
    state = acting(act(state, 0, { type: "stand" }));
    expect(state.currentTurn).toBe(1);

    const end = finished(act(state, 1, { type: "stand" }));
    expect(end.outcomes[0]).toEqual(["win", "win"]); // 21 and 19 beat 17
    expect(end.outcomes[1]).toEqual(["push"]);
    expect(settle(end)).toEqual({ 0: 200, 1: 0 });
  });

  it("a two-card 21 after a split is a plain 21, not a natural", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Ac", "Ad"] },
      dealer: ["Ts", "7s"],
      draws: ["Kh", "5h"],
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    // Split aces take one card each and stop; the round resolves at once.
    const end = finished(act(state, 0, { type: "split" }));
    expect(end.players[0].hands.map((h) => h.done)).toEqual([true, true]);
    expect(labelsOf(end.players[0].hands[0].cards)).toEqual(["Ac", "Kh"]);
    expect(end.outcomes[0]).toEqual(["win", "lose"]); // 21 (not 3:2) and 16 vs 17
    expect(settle(end)).toEqual({ 0: 0 });
    const view = viewFor(end, 0);
    if (view.phase !== "finished") throw new Error("expected finished view");
    expect(view.players[0].hands[0].natural).toBe(false);
  });

  it("pairs by blackjack value: a ten and a face split, a ten and an ace do not", () => {
    const tens = acting(
      createGame({
        seats: [0],
        stake: 100,
        shuffledShoe: buildShoe([0], { hands: { 0: ["Tc", "Kd"] }, dealer: ["2s", "3s"] }),
      }),
    );
    expect(canSplit(tens.players[0])).toBe(true);

    const mixed = acting(
      createGame({
        seats: [0],
        stake: 100,
        shuffledShoe: buildShoe([0], { hands: { 0: ["9c", "Ad"] }, dealer: ["2s", "3s"] }),
      }),
    );
    expect(canSplit(mixed.players[0])).toBe(false);
    expectRejected(mixed, 0, { type: "split" }, "cannot-split");
  });

  it("cannot split after a hit, and a double on a split hand doubles only that hand", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["6c", "6d"] },
      dealer: ["Ts", "7s"],
      draws: ["5h", "4h", "Th", "9h"], // hands 11 and 10; hand 1 doubles into Th (21), hand 2 doubles into 9h (19)
    });
    let state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    state = acting(act(state, 0, { type: "split" }));
    state = acting(act(state, 0, { type: "double" }));
    expect(state.players[0].hands[0]).toMatchObject({ bet: 200, doubled: true, done: true });
    expect(state.players[0].hands[1]).toMatchObject({ bet: 100, doubled: false, done: false });
    const end = finished(act(state, 0, { type: "double" }));
    expect(end.outcomes[0]).toEqual(["win", "win"]);
    expect(settle(end)).toEqual({ 0: 400 });

    const hitFirst = acting(
      createGame({
        seats: [0],
        stake: 100,
        shuffledShoe: buildShoe([0], { hands: { 0: ["3c", "3d"] }, dealer: ["Ts", "7s"], draws: ["2h"] }),
      }),
    );
    const afterHit = acting(act(hitFirst, 0, { type: "hit" }));
    expectRejected(afterHit, 0, { type: "split" }, "cannot-split");
  });
});

describe("per-seat bets", () => {
  it("each seat wagers its own bet, defaulting to the stake, and settles on it", () => {
    const shoe = buildShoe([0, 1, 2], {
      hands: { 0: ["Tc", "9c"], 1: ["Ac", "Kc"], 2: ["Td", "5d"] },
      dealer: ["Ts", "7s"],
    });
    let state = acting(createGame({ seats: [0, 1, 2], stake: 50, bets: { 0: 300, 1: 75 }, shuffledShoe: shoe }));
    expect(state.players[0].hands[0].bet).toBe(300);
    expect(state.players[1].hands[0].bet).toBe(75);
    expect(state.players[2].hands[0].bet).toBe(50);
    expect(state.currentTurn).toBe(0);
    state = acting(act(state, 0, { type: "stand" }));
    const end = finished(act(state, 2, { type: "stand" }));
    expect(settle(end)).toEqual({ 0: 300, 1: 112, 2: -50 }); // 19 wins, natural floor(1.5 x 75), 15 loses
  });

  it("rejects a bet below the stake or not a whole number", () => {
    const shoe = buildShoe([0], { hands: { 0: ["Tc", "9c"] }, dealer: ["Ts", "7s"] });
    expect(() => createGame({ seats: [0], stake: 50, bets: { 0: 49 }, shuffledShoe: shoe })).toThrow(/>= stake/);
    expect(() => createGame({ seats: [0], stake: 50, bets: { 0: 50.5 }, shuffledShoe: shoe })).toThrow(/>= stake/);
  });
});
