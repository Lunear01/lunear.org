import { describe, expect, it } from "vitest";
import {
  canSurrender,
  createGame,
  insuranceCost,
  settle,
  viewFor,
  type ActingState,
  type FinishedState,
  type GameState,
  type InsuranceState,
} from "../src/game";
import { act, buildShoe, expectRejected, labelsOf } from "./helpers";

function insurance(state: GameState): InsuranceState {
  if (state.phase !== "insurance") throw new Error(`expected insurance state, got ${state.phase}`);
  return state;
}

function acting(state: GameState): ActingState {
  if (state.phase !== "acting") throw new Error(`expected acting state, got ${state.phase}`);
  return state;
}

function finished(state: GameState): FinishedState {
  if (state.phase !== "finished") throw new Error(`expected finished state, got ${state.phase}`);
  return state;
}

describe("insurance", () => {
  it("is offered on an Ace up card to every seat, naturals included, and costs half the bet floored", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Ac", "Kc"], 1: ["Th", "9h"] },
      dealer: ["Ad", "7d"],
    });
    const state = insurance(createGame({ seats: [0, 1], stake: 50, bets: { 1: 75 }, shuffledShoe: shoe }));
    expect(state.pendingInsurance).toEqual([0, 1]);
    expect(state.insurance).toEqual({});
    expect(insuranceCost(75)).toBe(37);

    const view = viewFor(state, 1);
    if (view.phase !== "insurance") throw new Error("expected insurance view");
    expect(view.dealerUpCard.id.startsWith("Ad")).toBe(true);
    expect("dealerCards" in view).toBe(false);
    expect(view.pendingInsurance).toEqual([0, 1]);
    expect(view.players[0].hands[0].natural).toBe(true);
  });

  it("rejects game actions during insurance and insurance actions outside it", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["5c", "6c"], 1: ["Th", "9h"] },
      dealer: ["Ad", "7d"],
    });
    const state = insurance(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    expectRejected(state, 0, { type: "hit" }, "wrong-phase");
    expectRejected(state, 0, { type: "surrender" }, "wrong-phase");
    expectRejected(state, 3, { type: "insure" }, "not-your-turn");

    const afterOne = insurance(act(state, 1, { type: "declineInsurance" }));
    expect(afterOne.pendingInsurance).toEqual([0]);
    expectRejected(afterOne, 1, { type: "insure" }, "not-your-turn");

    const play = acting(act(afterOne, 0, { type: "insure" }));
    expectRejected(play, 0, { type: "insure" }, "wrong-phase");
    expectRejected(play, 0, { type: "declineInsurance" }, "wrong-phase");
  });

  it("decisions arrive in any order; the last one peeks — no natural loses the insurance and play starts", () => {
    const shoe = buildShoe([0, 1, 2], {
      hands: { 0: ["5c", "6c"], 1: ["Th", "9h"], 2: ["8s", "8d"] },
      dealer: ["Ad", "7d"],
    });
    let state: GameState = createGame({ seats: [0, 1, 2], stake: 100, shuffledShoe: shoe });
    state = act(state, 2, { type: "insure" });
    state = act(state, 0, { type: "declineInsurance" });
    const play = acting(act(state, 1, { type: "insure" }));
    expect(play.insurance).toEqual({ 1: 50, 2: 50 });
    expect(play.currentTurn).toBe(0);
    expect(viewFor(play, 0).phase === "acting" && viewFor(play, 0).insurance).toEqual({ 1: 50, 2: 50 });

    state = act(play, 0, { type: "stand" });
    state = act(state, 1, { type: "stand" });
    const end = finished(act(state, 2, { type: "stand" }));
    expect(labelsOf(end.dealerCards)).toEqual(["Ad", "7d"]); // soft 18, stands
    expect(end.outcomes).toEqual({ 0: ["lose"], 1: ["win"], 2: ["lose"] });
    // 11 loses 100; 19 wins 100 minus 50 insurance; 16 loses 100 and 50 insurance.
    expect(settle(end)).toEqual({ 0: -100, 1: 50, 2: -150 });
    const view = viewFor(end, 0);
    if (view.phase !== "finished") throw new Error("expected finished view");
    expect(view.dealerNatural).toBe(false);
    expect(view.insuranceDeltas).toEqual({ 1: -50, 2: -50 });
  });

  it("a dealer natural after the peek finishes at once, paying insurance 2:1", () => {
    const shoe = buildShoe([0, 1, 2], {
      hands: { 0: ["Ac", "Kc"], 1: ["Th", "9h"], 2: ["8s", "8d"] },
      dealer: ["Ad", "Qd"],
    });
    let state: GameState = createGame({ seats: [0, 1, 2], stake: 100, shuffledShoe: shoe });
    state = act(state, 0, { type: "insure" });
    state = act(state, 1, { type: "insure" });
    const end = finished(act(state, 2, { type: "declineInsurance" }));
    expect(end.dealerCards).toHaveLength(2);
    expect(end.outcomes).toEqual({ 0: ["push"], 1: ["lose"], 2: ["lose"] });
    expect(end.insurance).toEqual({ 0: 50, 1: 50 });
    // Natural pushes and insurance pays 100; 19 loses 100 but insurance pays 100; 16 just loses.
    expect(settle(end)).toEqual({ 0: 100, 1: 0, 2: -100 });
    const view = viewFor(end, 2);
    if (view.phase !== "finished") throw new Error("expected finished view");
    expect(view.dealerNatural).toBe(true);
    expect(view.insuranceDeltas).toEqual({ 0: 100, 1: 100 });
  });

  it("all seats dealt naturals: the peek finishes the round without a dealer draw", () => {
    const shoe = buildShoe([0], { hands: { 0: ["Ac", "Kc"] }, dealer: ["Ad", "6d"] });
    const state = insurance(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "insure" }));
    expect(end.dealerCards).toHaveLength(2);
    expect(end.outcomes[0]).toEqual(["blackjack"]);
    expect(settle(end)).toEqual({ 0: 100 }); // 150 - 50 insurance
  });

  it("a ten-up Ace-hole natural still finishes at the deal with no insurance offered", () => {
    const shoe = buildShoe([0], { hands: { 0: ["Th", "9h"] }, dealer: ["Kd", "Ad"] });
    const end = finished(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    expect(end.insurance).toEqual({});
    expect(settle(end)).toEqual({ 0: -100 });
  });
});

describe("surrender", () => {
  it("ends the hand on the first decision for half the bet, rounded up, and the dealer skips it", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Tc", "6c"], 1: ["Th", "9h"] },
      dealer: ["9d", "7d"],
      draws: ["5s"], // dealer 16 -> 21 only if it draws; seat 1's 19 forces the draw
    });
    let state = acting(createGame({ seats: [0, 1], stake: 25, shuffledShoe: shoe }));
    expect(canSurrender(state.players[0].hands[0])).toBe(true);
    expect(viewFor(state, 1).players[0].hands[0].canSurrender).toBe(true);
    state = acting(act(state, 0, { type: "surrender" }));
    expect(state.players[0].hands[0]).toMatchObject({ done: true, surrendered: true });
    expect(state.currentTurn).toBe(1);
    const end = finished(act(state, 1, { type: "stand" }));
    expect(end.outcomes).toEqual({ 0: ["surrender"], 1: ["lose"] });
    expect(settle(end)).toEqual({ 0: -13, 1: -25 }); // ceil(25 / 2)
    const view = viewFor(end, 0);
    if (view.phase !== "finished") throw new Error("expected finished view");
    expect(view.players[0].hands[0].surrendered).toBe(true);
  });

  it("when every hand surrendered or busted the dealer does not draw", () => {
    const shoe = buildShoe([0], { hands: { 0: ["Tc", "6c"] }, dealer: ["9d", "7d"], draws: ["5s"] });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "surrender" }));
    expect(end.dealerCards).toHaveLength(2);
    expect(settle(end)).toEqual({ 0: -50 });
  });

  it("is refused after a hit, after a double, on a split hand, and out of turn", () => {
    const hit = acting(
      createGame({
        seats: [0],
        stake: 100,
        shuffledShoe: buildShoe([0], { hands: { 0: ["2c", "3c"] }, dealer: ["9d", "7d"], draws: ["4h"] }),
      }),
    );
    const afterHit = acting(act(hit, 0, { type: "hit" }));
    expect(canSurrender(afterHit.players[0].hands[0])).toBe(false);
    expectRejected(afterHit, 0, { type: "surrender" }, "cannot-surrender");

    const split = acting(
      createGame({
        seats: [0],
        stake: 100,
        shuffledShoe: buildShoe([0], { hands: { 0: ["8c", "8d"] }, dealer: ["9d", "7d"], draws: ["2h", "3h"] }),
      }),
    );
    const afterSplit = acting(act(split, 0, { type: "split" }));
    expectRejected(afterSplit, 0, { type: "surrender" }, "cannot-surrender");

    const twoSeats = acting(
      createGame({
        seats: [0, 1],
        stake: 100,
        shuffledShoe: buildShoe([0, 1], { hands: { 0: ["Tc", "6c"], 1: ["Th", "9h"] }, dealer: ["9d", "7d"] }),
      }),
    );
    expectRejected(twoSeats, 1, { type: "surrender" }, "not-your-turn");
  });

  it("is allowed after declining insurance, since the hand has had no decision yet", () => {
    const shoe = buildShoe([0], { hands: { 0: ["Tc", "6c"] }, dealer: ["Ad", "7d"] });
    const dealt = createGame({ seats: [0], stake: 100, shuffledShoe: shoe });
    const state = acting(act(dealt, 0, { type: "declineInsurance" }));
    const end = finished(act(state, 0, { type: "surrender" }));
    expect(end.outcomes[0]).toEqual(["surrender"]);
    expect(settle(end)).toEqual({ 0: -50 });
  });
});
