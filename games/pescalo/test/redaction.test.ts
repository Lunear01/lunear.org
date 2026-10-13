import { describe, expect, it } from "vitest";
import { viewFor } from "../src/game";
import { ask, game, ids, playing } from "./helpers";

const HAND0 = ["7S", "7H", "9S", "JS", "QS", "KS", "AS"];
const HAND1 = ["7D", "8S", "8H", "JD", "QD", "KD", "AD"];

describe("viewFor", () => {
  it("reveals only the viewer's hand, with counts, books and pool size for the rest", () => {
    const state = playing(ask(game([0, 1], { 0: HAND0, 1: HAND1 }, ["3C"]), 0, 1, 9));
    const view = viewFor(state, 1);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.viewer).toBe(1);
    expect(ids(view.hand)).toEqual(HAND1);
    expect(view.handCounts).toEqual({ 0: 8, 1: 7, 2: 0, 3: 0, 4: 0 });
    expect(view.poolCount).toBe(52 - 14 - 1);
    expect(view.currentTurn).toBe(1);
    expect("hands" in view).toBe(false);
    expect("pool" in view).toBe(false);
  });

  it("never names a hidden draw in the public events", () => {
    const state = playing(ask(game([0, 1], { 0: HAND0, 1: HAND1 }, ["3C"]), 0, 1, 9));
    const text = JSON.stringify(viewFor(state, 1).lastEvents);
    expect(text).not.toContain("3C");
    expect(viewFor(state, 1).lastEvents.at(-1)).toEqual({ type: "drew-hidden", seat: 0 });
  });

  it("gives a spectator seat an empty hand", () => {
    const view = viewFor(game([0, 1], { 0: HAND0, 1: HAND1 }), 3);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.hand).toEqual([]);
    expect(view.activeSeats).toEqual([0, 1]);
  });
});
