import { describe, expect, it } from "vitest";
import { createShoe } from "../src/cards";
import { createGame, handValue, type ActingState, type FinishedState } from "../src/game";
import { act, buildShoe, expectRejected, labelsOf } from "./helpers";

function acting(state: ReturnType<typeof createGame>): ActingState {
  if (state.phase !== "acting") throw new Error(`expected acting state, got ${state.phase}`);
  return state;
}

function finished(state: ReturnType<typeof createGame>): FinishedState {
  if (state.phase !== "finished") throw new Error(`expected finished state, got ${state.phase}`);
  return state;
}

describe("createGame validation", () => {
  const shoe = createShoe();

  it("rejects bad seat lists, stakes, and short shoes", () => {
    expect(() => createGame({ seats: [], stake: 100, shuffledShoe: shoe })).toThrow(/1-5 seats/);
    expect(() => createGame({ seats: [0, 1, 2, 3, 4, 5], stake: 100, shuffledShoe: shoe })).toThrow(/1-5 seats/);
    expect(() => createGame({ seats: [1, 1], stake: 100, shuffledShoe: shoe })).toThrow(/unique/);
    expect(() => createGame({ seats: [5], stake: 100, shuffledShoe: shoe })).toThrow(/0-4/);
    expect(() => createGame({ seats: [0], stake: 0, shuffledShoe: shoe })).toThrow(/stake/);
    expect(() => createGame({ seats: [0], stake: 100, shuffledShoe: shoe.slice(0, 100) })).toThrow(/at least/);
  });
});

describe("the deal", () => {
  it("deals seat blocks in ascending order, then the dealer, lowest seat first to act", () => {
    const shoe = buildShoe([1, 3, 4], {
      hands: { 1: ["2c", "3c"], 3: ["4c", "5c"], 4: ["6c", "7c"] },
      dealer: ["8c", "9c"],
    });
    const state = acting(createGame({ seats: [4, 1, 3], stake: 100, shuffledShoe: shoe }));
    expect(state.seats).toEqual([1, 3, 4]);
    expect(labelsOf(state.players[1].cards)).toEqual(["2c", "3c"]);
    expect(labelsOf(state.players[3].cards)).toEqual(["4c", "5c"]);
    expect(labelsOf(state.players[4].cards)).toEqual(["6c", "7c"]);
    expect(labelsOf(state.dealerCards)).toEqual(["8c", "9c"]);
    expect(state.toAct).toEqual([1, 3, 4]);
    expect(state.currentTurn).toBe(1);
    expect(state.players[1].bet).toBe(100);
  });

  it("a seat dealt a natural is done up front and skipped in toAct", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Ac", "Kc"], 1: ["5c", "6c"] },
      dealer: ["7c", "8c"],
    });
    const state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    expect(state.players[0].done).toBe(true);
    expect(state.toAct).toEqual([1]);
    expect(state.currentTurn).toBe(1);
  });

  it("a dealer natural finishes the round at the deal: naturals push, everyone else loses", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Ac", "Kc"], 1: ["Th", "9h"] },
      dealer: ["Ad", "Qd"],
    });
    const state = finished(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    expect(state.outcomes[0]).toBe("push");
    expect(state.outcomes[1]).toBe("lose");
    expect(state.dealerCards).toHaveLength(2);
  });

  it("every seat dealt a natural finishes without the dealer drawing", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Ac", "Kc"] },
      dealer: ["6d", "Td"],
    });
    const state = finished(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    expect(state.outcomes[0]).toBe("blackjack");
    expect(state.dealerCards).toHaveLength(2);
  });
});

describe("player actions", () => {
  it("a hit below 21 keeps the turn; standing passes it on", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["2c", "3c"], 1: ["5c", "6c"] },
      dealer: ["7c", "Th"],
      draws: ["4d"],
    });
    let state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    state = acting(act(state, 0, { type: "hit" }));
    expect(labelsOf(state.players[0].cards)).toEqual(["2c", "3c", "4d"]);
    expect(state.currentTurn).toBe(0);
    state = acting(act(state, 0, { type: "stand" }));
    expect(state.players[0].done).toBe(true);
    expect(state.currentTurn).toBe(1);
  });

  it("hitting to exactly 21 ends the turn automatically", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Tc", "5c"], 1: ["5d", "6d"] },
      dealer: ["7c", "Th"],
      draws: ["6h"],
    });
    let state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    state = acting(act(state, 0, { type: "hit" }));
    expect(handValue(state.players[0].cards).total).toBe(21);
    expect(state.players[0].done).toBe(true);
    expect(state.currentTurn).toBe(1);
  });

  it("busting ends the turn and loses regardless of the dealer", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Tc", "9c"] },
      dealer: ["6d", "Th"],
      draws: ["5h"], // player 19 -> 24, bust; dealer (16) never draws
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "hit" }));
    expect(end.outcomes[0]).toBe("lose");
  });

  it("double down doubles the bet, draws one card, and ends the turn", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["6c", "5c"] },
      dealer: ["Td", "8d"],
      draws: ["Th"],
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "double" }));
    expect(end.players[0].bet).toBe(200);
    expect(end.players[0].doubled).toBe(true);
    expect(labelsOf(end.players[0].cards)).toEqual(["6c", "5c", "Th"]);
    expect(end.outcomes[0]).toBe("win"); // 21 vs dealer 18
  });

  it("rejects double after a hit, out-of-turn actions, and actions on a finished round", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["2c", "3c"], 1: ["5c", "6c"] },
      dealer: ["7c", "Th"],
      draws: ["2d"],
    });
    let state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    expectRejected(state, 1, { type: "hit" }, "not-your-turn");
    expectRejected(state, 3, { type: "stand" }, "not-your-turn");
    state = acting(act(state, 0, { type: "hit" }));
    expectRejected(state, 0, { type: "double" }, "cannot-double");
    state = acting(act(state, 0, { type: "stand" }));
    const end = act(state, 1, { type: "stand" });
    expectRejected(end, 1, { type: "hit" }, "wrong-phase");
  });
});

describe("dealer play", () => {
  it("draws to 17+ once every seat has acted", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Tc", "8c"] },
      dealer: ["2d", "3d"],
      draws: ["4h", "5h", "6h"], // dealer: 2+3 -> 9 -> 14 -> 20
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "stand" }));
    expect(labelsOf(end.dealerCards)).toEqual(["2d", "3d", "4h", "5h", "6h"]);
    expect(end.outcomes[0]).toBe("lose"); // 18 vs 20
  });

  it("stands on soft 17", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Tc", "7c"] },
      dealer: ["Ad", "6d"],
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "stand" }));
    expect(end.dealerCards).toHaveLength(2);
    expect(end.outcomes[0]).toBe("push"); // 17 vs soft 17
  });

  it("does not draw when every seat busted", () => {
    const shoe = buildShoe([0], {
      hands: { 0: ["Tc", "9c"] },
      dealer: ["2d", "3d"],
      draws: ["5h"],
    });
    const state = acting(createGame({ seats: [0], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 0, { type: "hit" }));
    expect(end.dealerCards).toHaveLength(2);
    expect(end.outcomes[0]).toBe("lose");
  });

  it("a dealer bust pays every standing seat", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Tc", "2c"], 1: ["Th", "9h"] },
      dealer: ["Td", "6d"],
      draws: ["8s"], // dealer 16 -> 24, bust
    });
    let state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    state = acting(act(state, 0, { type: "stand" }));
    const end = finished(act(state, 1, { type: "stand" }));
    expect(end.outcomes[0]).toBe("win");
    expect(end.outcomes[1]).toBe("win");
  });

  it("a player natural still pays 3:2 when the dealer draws to 21", () => {
    const shoe = buildShoe([0, 1], {
      hands: { 0: ["Ac", "Kc"], 1: ["Th", "Jh"] },
      dealer: ["Td", "5d"],
      draws: ["6s"], // dealer 15 -> 21, drawn (not a natural)
    });
    const state = acting(createGame({ seats: [0, 1], stake: 100, shuffledShoe: shoe }));
    const end = finished(act(state, 1, { type: "stand" }));
    expect(end.outcomes[0]).toBe("blackjack");
    expect(end.outcomes[1]).toBe("lose"); // 20 vs 21
  });
});
