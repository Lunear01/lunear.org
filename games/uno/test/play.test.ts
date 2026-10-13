import { describe, expect, it } from "vitest";
import { isPlayable, matches, nextSeat, topCard } from "../src/game";
import { act, cardsOf, expectRejected, ids, newGame, playing, seeded } from "./helpers";

// Three seats: 0 leads on a green 5.
const THREE = {
  hands: {
    0: ["g1a", "r5a", "gSa", "gRa", "gDa", "Wa", "W4a"],
    1: ["b1a", "b2a", "b3a", "b4a", "b6a", "b7a", "g9a"],
    2: ["y1a", "y2a", "y3a", "y4a", "y6a", "y7a", "y8a"],
  },
  flips: ["g5a"],
  draws: ["r9a", "y0", "b0", "g0", "r0", "b9a"],
} as const;

describe("matches / isPlayable", () => {
  it("matches by colour, by number, by action kind, and always for wilds", () => {
    const [g5, g1, r5, r6, gS, rS, w, w4] = cardsOf(["g5a", "g1a", "r5a", "r6a", "gSa", "rSa", "Wa", "W4a"]);
    expect(matches(g1, g5, "green")).toBe(true);
    expect(matches(r5, g5, "green")).toBe(true);
    expect(matches(r6, g5, "green")).toBe(false);
    expect(matches(gS, g5, "green")).toBe(true);
    expect(matches(rS, g5, "green")).toBe(false);
    expect(matches(rS, gS, "green")).toBe(true);
    expect(matches(w, g5, "green")).toBe(true);
    expect(matches(w4, g5, "green")).toBe(true);
  });

  it("only matches the chosen colour on top of a wild", () => {
    const [w, r5, g5, rS] = cardsOf(["Wa", "r5a", "g5a", "rSa"]);
    expect(matches(r5, w, "red")).toBe(true);
    expect(matches(g5, w, "red")).toBe(false);
    expect(matches(rS, w, "red")).toBe(true);
  });

  it("forbids wild draw four while holding a card of the current colour", () => {
    const [g5, w4, g1, r1] = cardsOf(["g5a", "W4a", "g1a", "r1a"]);
    expect(isPlayable(w4, [w4, g1], g5, "green")).toBe(false);
    expect(isPlayable(w4, [w4, r1], g5, "green")).toBe(true);
    expect(isPlayable(w4, [w4], g5, "green")).toBe(true);
  });
});

describe("nextSeat", () => {
  it("walks active seats in either direction with wraparound", () => {
    expect(nextSeat([0, 2, 5], 5, 1)).toBe(0);
    expect(nextSeat([0, 2, 5], 0, -1)).toBe(5);
    expect(nextSeat([0, 2, 5], 2, 1)).toBe(5);
  });
});

describe("play", () => {
  it("a matching colour card moves the turn on and sets the colour", () => {
    const s = playing(act(newGame(THREE), 0, { type: "play", cardId: "g1a" }));
    expect(topCard(s).id).toBe("g1a");
    expect(s.currentColor).toBe("green");
    expect(s.currentTurn).toBe(1);
    expect(ids(s.hands[0])).not.toContain("g1a");
    expect(s.lastEvents).toEqual([{ type: "played", seat: 0, card: topCard(s), color: "green" }]);
  });

  it("a matching number of another colour changes the colour", () => {
    const s = playing(act(newGame(THREE), 0, { type: "play", cardId: "r5a" }));
    expect(s.currentColor).toBe("red");
    expect(s.currentTurn).toBe(1);
  });

  it("skip passes over the next seat", () => {
    const s = playing(act(newGame(THREE), 0, { type: "play", cardId: "gSa" }));
    expect(s.currentTurn).toBe(2);
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played", "skipped"]);
  });

  it("reverse flips direction with three or more players", () => {
    const s = playing(act(newGame(THREE), 0, { type: "play", cardId: "gRa" }));
    expect(s.direction).toBe(-1);
    expect(s.currentTurn).toBe(2);
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played", "reversed"]);
  });

  it("reverse acts as a skip with two players", () => {
    const two = { ...THREE, hands: { 0: THREE.hands[0], 1: THREE.hands[1] } };
    const s = playing(act(newGame(two), 0, { type: "play", cardId: "gRa" }));
    expect(s.direction).toBe(-1);
    expect(s.currentTurn).toBe(0);
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played", "reversed", "skipped"]);
  });

  it("draw two makes the next seat draw two and lose the turn", () => {
    const s = playing(act(newGame(THREE), 0, { type: "play", cardId: "gDa" }));
    expect(ids(s.hands[1]).slice(-2)).toEqual(["r9a", "y0"]);
    expect(s.hands[1]).toHaveLength(9);
    expect(s.currentTurn).toBe(2);
    expect(s.lastEvents).toEqual([
      { type: "played", seat: 0, card: topCard(s), color: "green" },
      { type: "drew", seat: 1, count: 2 },
      { type: "skipped", seat: 1 },
    ]);
  });

  it("wild needs a colour and then sets it", () => {
    const state = newGame(THREE);
    expectRejected(state, 0, { type: "play", cardId: "Wa" }, "color-required");
    expectRejected(state, 0, { type: "play", cardId: "Wa", color: "purple" as never }, "invalid-color");
    const s = playing(act(state, 0, { type: "play", cardId: "Wa", color: "blue" }));
    expect(s.currentColor).toBe("blue");
    expect(s.currentTurn).toBe(1);
    // Seat 1 may now play blue, but not the green 9.
    expectRejected(s, 1, { type: "play", cardId: "g9a" }, "card-not-playable");
    expect(playing(act(s, 1, { type: "play", cardId: "b1a" })).currentTurn).toBe(2);
  });

  it("wild draw four is refused while holding the current colour, and penalises the next seat otherwise", () => {
    const state = newGame(THREE);
    expectRejected(state, 0, { type: "play", cardId: "W4a", color: "red" }, "wild-draw-four-not-allowed");
    // Shed every green first: play red 5 so the colour becomes red, go around, then W4 is legal.
    let s = playing(act(state, 0, { type: "play", cardId: "r5a" }));
    s = playing(act(s, 1, { type: "draw" }, seeded())); // b* on red: no play, drew r9a -> playable
    expect(s.pendingDraw).toBe("r9a");
    s = playing(act(s, 1, { type: "play", cardId: "r9a" }));
    s = playing(act(s, 2, { type: "draw" })); // y* on red: drew y0, not playable -> turn passes
    expect(s.currentTurn).toBe(0);
    // Seat 0 holds no red now (g1a, gSa, gRa, gDa, Wa, W4a).
    s = playing(act(s, 0, { type: "play", cardId: "W4a", color: "yellow" }));
    expect(s.currentColor).toBe("yellow");
    expect(s.hands[1]).toHaveLength(7 + 4);
    expect(s.currentTurn).toBe(2);
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played", "drew", "skipped"]);
  });

  it("rejects a card not in hand, an unplayable card, and out-of-turn or wrong-phase actions", () => {
    const state = newGame(THREE);
    expectRejected(state, 0, { type: "play", cardId: "b1a" }, "cards-not-in-hand");
    expectRejected(state, 1, { type: "play", cardId: "b1a" }, "not-your-turn");
    const s = playing(act(state, 0, { type: "play", cardId: "g1a" }));
    expectRejected(s, 1, { type: "play", cardId: "b2a" }, "card-not-playable");
    expectRejected(s, 1, { type: "pass" }, "cannot-pass");
  });
});

describe("draw", () => {
  it("a drawn playable card may be played at once or passed on", () => {
    let s = playing(act(newGame(THREE), 0, { type: "play", cardId: "r5a" }));
    s = playing(act(s, 1, { type: "draw" }));
    expect(s.currentTurn).toBe(1);
    expect(s.pendingDraw).toBe("r9a");
    expect(s.lastEvents).toEqual([{ type: "drew", seat: 1, count: 1 }]);
    expectRejected(s, 1, { type: "draw" }, "already-drew");
    expectRejected(s, 1, { type: "play", cardId: "b1a" }, "must-play-drawn-card");

    const passed = playing(act(s, 1, { type: "pass" }));
    expect(passed.currentTurn).toBe(2);
    expect(passed.pendingDraw).toBeNull();
    expect(passed.hands[1]).toHaveLength(8);
    expect(passed.lastEvents).toEqual([{ type: "passed", seat: 1 }]);

    const played = playing(act(s, 1, { type: "play", cardId: "r9a" }));
    expect(played.currentTurn).toBe(2);
    expect(played.hands[1]).toHaveLength(7);
  });

  it("a drawn unplayable card ends the turn", () => {
    let s = playing(act(newGame(THREE), 0, { type: "play", cardId: "g1a" }));
    s = playing(act(s, 1, { type: "draw" })); // drew r9a on green 1: not playable
    expect(s.currentTurn).toBe(2);
    expect(s.pendingDraw).toBeNull();
    expect(ids(s.hands[1])).toContain("r9a");
  });

  it("refills the draw pile from the discard pile minus its top card", () => {
    const start = newGame(THREE);
    // Leave a single card (r9a) on the draw pile.
    let s = playing(act({ ...start, drawPile: start.drawPile.slice(-1) }, 0, { type: "play", cardId: "gSa" }));
    s = playing(act(s, 2, { type: "draw" })); // r9a on a green skip: not playable, turn passes
    expect(s.currentTurn).toBe(0);
    expect(s.drawPile).toHaveLength(0);
    expect(s.discardPile.map((c) => c.id)).toEqual(["g5a", "gSa"]);
    s = playing(act(s, 0, { type: "draw" }, seeded(5)));
    expect(s.lastEvents[0]).toEqual({ type: "reshuffled", count: 1 });
    expect(s.discardPile.map((c) => c.id)).toEqual(["gSa"]);
    expect(s.drawPile).toHaveLength(0);
    expect(s.hands[0][s.hands[0].length - 1].id).toBe("g5a");
    // Green 5 on a green skip is playable, so seat 0 keeps the turn.
    expect(s.pendingDraw).toBe("g5a");
  });

  it("with nothing left to draw, the turn passes with an empty draw", () => {
    let s = newGame(THREE);
    s = { ...s, drawPile: [] };
    const next = playing(act(s, 0, { type: "draw" }));
    expect(next.currentTurn).toBe(1);
    expect(next.hands[0]).toHaveLength(7);
    expect(next.lastEvents).toEqual([{ type: "drew", seat: 0, count: 0 }]);
  });
});
