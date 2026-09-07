import { describe, expect, it } from "vitest";
import { createGame, viewFor, type ActingState } from "../src/game";
import { act, buildShoe, labelsOf } from "./helpers";

function deal(): ActingState {
  const shoe = buildShoe([0, 2], {
    hands: { 0: ["Ac", "6c"], 2: ["Tc", "9c"] },
    dealer: ["Kd", "7d"],
  });
  const state = createGame({ seats: [0, 2], stake: 100, shuffledShoe: shoe });
  if (state.phase !== "acting") throw new Error("expected acting");
  return state;
}

describe("viewFor while acting", () => {
  it("shows only the dealer's up card and every player's full hand with computed totals", () => {
    const view = viewFor(deal(), 2);
    if (view.phase !== "acting") throw new Error("expected acting view");
    expect(view.viewer).toBe(2);
    expect(view.dealerUpCard.id.startsWith("Kd")).toBe(true);
    expect("dealerCards" in view).toBe(false);
    expect("shoe" in view).toBe(false);
    expect(labelsOf(view.players[0].cards)).toEqual(["Ac", "6c"]);
    expect(view.players[0]).toMatchObject({ total: 17, soft: true, busted: false, natural: false });
    expect(view.players[2]).toMatchObject({ total: 19, soft: false, done: false, bet: 100 });
  });

  it("never throws for a viewer seat not dealt into the round", () => {
    const view = viewFor(deal(), 4);
    expect(view.players[4]).toBeUndefined();
    expect(view.seats).toEqual([0, 2]);
  });
});

describe("viewFor when finished", () => {
  it("reveals the full dealer hand, totals, and outcomes", () => {
    let state = deal();
    state = act(state, 0, { type: "stand" }) as ActingState;
    const end = act(state, 2, { type: "stand" });
    if (end.phase !== "finished") throw new Error("expected finished");

    const view = viewFor(end, 0);
    if (view.phase !== "finished") throw new Error("expected finished view");
    expect(view.dealerTotal).toBe(17); // Kd + 7d
    expect(view.dealerBusted).toBe(false);
    expect(view.outcomes[0]).toBe("push"); // soft 17 vs 17
    expect(view.outcomes[2]).toBe("win"); // 19 vs 17
    expect(labelsOf(view.dealerCards)).toEqual(["Kd", "7d"]);
  });
});
