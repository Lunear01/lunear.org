import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import { createGame, type GameState, type PlayingState } from "../src/game";
import { buildDealOrder, expectRejected, pass, play } from "./helpers";

// Seat 1 holds 3D (the lowest card) so it leads; seat 0 holds a strong hand.
const SEAT0 = ["4D", "5D", "6D", "7D", "8D", "9S", "9H", "9D", "KS", "KH", "AS", "2S", "2H"];
const SEAT1 = ["3D", "3C", "3H", "4C", "5C", "6C", "7C", "8C", "10S", "JS", "QS", "AD", "2D"];
const SEAT2 = ["3S", "4H", "5H", "6H", "7H", "8H", "10H", "JH", "QH", "KD", "AH", "2C", "10D"];
const SEAT3 = ["4S", "5S", "6S", "7S", "8S", "9C", "10C", "JC", "QC", "KC", "AC", "JD", "QD"];

function fourSeatGame(): PlayingState {
  return createGame({ shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1, 2: SEAT2, 3: SEAT3 }), baseStake: 10 });
}

describe("createGame", () => {
  it("deals 13 to every active seat and gives the lead to the holder of the lowest card", () => {
    const state = fourSeatGame();
    expect(state.activeSeats).toEqual([0, 1, 2, 3]);
    for (const seat of [0, 1, 2, 3] as const) expect(state.hands[seat]).toHaveLength(13);
    expect(state.currentTurn).toBe(1);
    expect(state.leadCardId).toBe("3D");
    expect(state.lastPlay).toBeNull();
  });

  it("leaves inactive seats empty and leads with the lowest dealt card", () => {
    // Only seats 0 and 2 play; seat 1's block (holding 3D) stays undealt.
    const state = createGame({
      shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1, 2: SEAT2, 3: SEAT3 }),
      activeSeats: [2, 0],
      baseStake: 10,
    });
    expect(state.activeSeats).toEqual([0, 2]);
    expect(state.hands[1]).toEqual([]);
    expect(state.hands[3]).toEqual([]);
    expect(state.leadCardId).toBe("3S");
    expect(state.currentTurn).toBe(2);
  });

  it("rejects a wrong-size deck and bad seat lists", () => {
    expect(() => createGame({ shuffledDeck: createDeck().slice(0, 51), baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: createDeck(), activeSeats: [0], baseStake: 1 })).toThrow();
    expect(() => createGame({ shuffledDeck: createDeck(), activeSeats: [0, 0], baseStake: 1 })).toThrow();
  });
});

describe("first play", () => {
  it("must include the lead card", () => {
    const state = fourSeatGame();
    expectRejected(state, 1, { type: "play", cardIds: ["3C"] }, "must-include-lead-card");
    expectRejected(state, 1, { type: "play", cardIds: ["3C", "3H"] }, "must-include-lead-card");
    const next = play(state, 1, ["3D", "3C", "3H"]);
    expect(next.phase).toBe("playing");
    if (next.phase !== "playing") throw new Error("unreachable");
    expect(next.leadCardId).toBeNull();
    expect(next.lastPlay?.combo.category).toBe("triple");
    expect(next.currentTurn).toBe(2);
  });

  it("cannot be a pass", () => {
    expectRejected(fourSeatGame(), 1, { type: "pass" }, "cannot-pass-on-lead");
  });

  it("may be a five-card hand holding the lead card", () => {
    const next = play(fourSeatGame(), 1, ["3D", "4C", "5C", "6C", "7C"]);
    if (next.phase !== "playing") throw new Error("unreachable");
    expect(next.lastPlay?.combo.category).toBe("straight");
  });
});

describe("rejections", () => {
  it("refuses out-of-turn actions and wrong phases", () => {
    const state = fourSeatGame();
    expectRejected(state, 0, { type: "play", cardIds: ["4D"] }, "not-your-turn");
    expectRejected(state, 2, { type: "pass" }, "not-your-turn");
  });

  it("refuses empty, duplicate, foreign and shapeless selections", () => {
    const state = play(fourSeatGame(), 1, ["3D"]);
    expectRejected(state, 2, { type: "play", cardIds: [] }, "empty-play");
    expectRejected(state, 2, { type: "play", cardIds: ["3S", "3S"] }, "invalid-cards");
    expectRejected(state, 2, { type: "play", cardIds: ["4D"] }, "cards-not-in-hand");
    expectRejected(state, 2, { type: "play", cardIds: ["4H", "5H", "KD"] }, "invalid-cards");
  });

  it("requires the same card count, then a stronger combo", () => {
    const state = play(fourSeatGame(), 1, ["3D", "3C"]);
    expectRejected(state, 2, { type: "play", cardIds: ["4H"] }, "wrong-card-count");
    expectRejected(state, 2, { type: "play", cardIds: ["3S", "4H", "5H", "6H", "7H"] }, "wrong-card-count");
    expectRejected(state, 2, { type: "play", cardIds: ["3S", "4H"] }, "invalid-cards");
    const ok = play(state, 2, ["10H", "10D"]);
    expect(ok.phase).toBe("playing");
  });

  it("refuses a pair that does not outrank the pair on the table", () => {
    let state: GameState = play(fourSeatGame(), 1, ["3D", "3H"]);
    state = play(state, 2, ["10H", "10D"]);
    state = play(state, 3, ["JD", "JC"]);
    expectRejected(state, 0, { type: "play", cardIds: ["9S", "9H"] }, "must-beat-previous");
    const next = play(state, 0, ["KS", "KH"]);
    expect(next.phase).toBe("playing");
  });

  it("refuses a five-card hand that does not outrank the one on the table", () => {
    // Seat 1 leads a straight; seat 2's straight flush beats it; seat 3's
    // plain straight cannot follow a straight flush.
    const state = play(fourSeatGame(), 1, ["3D", "4C", "5C", "6C", "7C"]);
    const beaten = play(state, 2, ["4H", "5H", "6H", "7H", "8H"]);
    expect(beaten.phase).toBe("playing");
    expectRejected(beaten, 3, { type: "play", cardIds: ["9C", "10C", "JC", "QD", "KC"] }, "must-beat-previous");
    // A higher straight flush does beat it.
    const higher = play(beaten, 3, ["4S", "5S", "6S", "7S", "8S"]);
    expect(higher.phase).toBe("playing");
  });
});

describe("pass flow", () => {
  it("clears the trick once every other seat has passed and hands the lead back", () => {
    let state = play(fourSeatGame(), 1, ["3D"]);
    state = pass(state, 2);
    state = pass(state, 3);
    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.currentTurn).toBe(0);
    expect(state.lastPlay).not.toBeNull();
    state = pass(state, 0);
    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.currentTurn).toBe(1);
    expect(state.lastPlay).toBeNull();
    // Free lead: any shape, no lead-card rule any more.
    const led = play(state, 1, ["AD"]);
    if (led.phase !== "playing") throw new Error("unreachable");
    expect(led.lastPlay?.seat).toBe(1);
    expect(led.leadCardId).toBeNull();
  });

  it("keeps the trick alive while someone still beats it", () => {
    let state = play(fourSeatGame(), 1, ["3D"]);
    state = play(state, 2, ["3S"]);
    state = pass(state, 3);
    state = pass(state, 0);
    if (state.phase !== "playing") throw new Error("unreachable");
    // Back at seat 1, who did not make the last play: still a 3S to beat.
    expect(state.currentTurn).toBe(1);
    expect(state.lastPlay?.seat).toBe(2);
    state = pass(state, 1);
    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.currentTurn).toBe(2);
    expect(state.lastPlay).toBeNull();
  });

  it("records plays and passes in history", () => {
    let state = play(fourSeatGame(), 1, ["3D"]);
    state = pass(state, 2);
    expect(state.history.map((h) => [h.seat, h.combo?.category ?? null])).toEqual([
      [1, "single"],
      [2, null],
    ]);
  });
});

describe("finishing", () => {
  it("ends the hand when a seat empties its hand and reveals every hand", () => {
    // Two seats; seat 1 leads and sheds all 13 cards while seat 0 passes.
    let state: GameState = createGame({
      shuffledDeck: buildDealOrder({ 0: SEAT0, 1: SEAT1 }),
      activeSeats: [0, 1],
      baseStake: 10,
    });
    state = play(state, 1, ["3D", "4C", "5C", "6C", "7C"]);
    state = pass(state, 0);
    state = play(state, 1, ["3C", "3H"]);
    state = pass(state, 0);
    state = play(state, 1, ["8C"]);
    state = pass(state, 0);
    state = play(state, 1, ["10S"]);
    state = pass(state, 0);
    state = play(state, 1, ["JS"]);
    state = pass(state, 0);
    state = play(state, 1, ["QS"]);
    state = pass(state, 0);
    state = play(state, 1, ["AD"]);
    state = pass(state, 0);
    expect(state.phase).toBe("playing");
    state = play(state, 1, ["2D"]);
    expect(state.phase).toBe("finished");
    if (state.phase !== "finished") throw new Error("unreachable");
    expect(state.winner).toBe(1);
    expect(state.hands[1]).toEqual([]);
    expect(state.hands[0]).toHaveLength(13);
    expect(state.activeSeats).toEqual([0, 1]);
    expectRejected(state, 0, { type: "pass" }, "wrong-phase");
  });
});
