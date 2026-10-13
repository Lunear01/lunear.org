import { describe, expect, it } from "vitest";
import { createGame, viewFor, type GameState } from "../src/game";
import { buildDealOrder, pass, play } from "./helpers";

const SEAT0 = ["4D", "5D", "6D", "7D", "8D", "9S", "9H", "9D", "KS", "KH", "AS", "2S", "2H"];
const SEAT1 = ["3D", "3C", "3H", "4C", "5C", "6C", "7C", "8C", "10S", "JS", "QS", "AD", "2D"];

describe("viewFor", () => {
  it("shows the viewer only its own hand plus counts for everyone", () => {
    const state = createGame({ shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1 }), baseStake: 10 });
    const view = viewFor(state, 0);
    expect(view.phase).toBe("playing");
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.viewer).toBe(0);
    expect(view.hand.map((c) => c.id)).toEqual(SEAT0);
    expect(view.handCounts).toEqual({ 0: 13, 1: 13, 2: 13, 3: 13 });
    expect(view.leadCardId).toBe("3D");
    expect(view.currentTurn).toBe(1);
    expect(JSON.stringify(view)).not.toContain('"hands"');
  });

  it("is safe for a seat outside the game", () => {
    const state = createGame({
      shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1 }),
      activeSeats: [0, 1],
      baseStake: 10,
    });
    const view = viewFor(state, 3);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.hand).toEqual([]);
    expect(view.activeSeats).toEqual([0, 1]);
  });

  it("exposes the last play's cards to every seat", () => {
    let state: GameState = createGame({ shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1 }), baseStake: 10 });
    state = play(state, 1, ["3D", "3C"]);
    const view = viewFor(state, 3);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.lastPlay?.combo.cards.map((c) => c.id)).toEqual(["3D", "3C"]);
  });

  it("reveals every remaining hand once finished", () => {
    let state: GameState = createGame({
      shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1 }),
      activeSeats: [0, 1],
      baseStake: 10,
    });
    for (const ids of [["3D", "4C", "5C", "6C", "7C"], ["3C", "3H"], ["8C"], ["10S"], ["JS"], ["QS"], ["AD"]]) {
      state = play(state, 1, ids);
      state = pass(state, 0);
    }
    state = play(state, 1, ["2D"]);
    const view = viewFor(state, 1);
    expect(view.phase).toBe("finished");
    if (view.phase !== "finished") throw new Error("unreachable");
    expect(view.viewer).toBe(1);
    expect(view.hands[0].map((c) => c.id)).toEqual(SEAT0);
  });
});
