import { describe, expect, it } from "vitest";
import { handPoints, paymentFor, settle, viewFor, type FinishedState } from "../src/game";
import { act, cardsOf, expectRejected, newGame, playing, seeded } from "./helpers";

// Seat 0 holds one card and goes out on the first play.
const ENDGAME = {
  hands: {
    0: ["g1a", "g2a", "g3a", "g4a", "g6a", "g7a", "g8a"],
    1: ["b1a", "bSa", "Wa", "b4a", "b6a", "b7a", "b9a"],
    2: ["y1a", "y2a", "y3a", "y4a", "y6a", "y7a", "y8a"],
  },
  flips: ["g5a"],
  draws: ["r9a", "r0"],
} as const;

function finishWithOneCard(): FinishedState {
  const start = newGame(ENDGAME, { baseStake: 100 });
  const oneCard = { ...start, hands: { ...start.hands, 0: cardsOf(["gDa"]) } };
  const result = act(oneCard, 0, { type: "play", cardId: "gDa" });
  if (result.phase !== "finished") throw new Error("expected finished");
  return result;
}

describe("finishing", () => {
  it("ends the hand when a player empties their hand, after the card's penalty applies", () => {
    const finished = finishWithOneCard();
    expect(finished.winner).toBe(0);
    expect(finished.hands[0]).toEqual([]);
    // Draw two still hit seat 1: 7 cards + r9a + r0.
    expect(finished.hands[1]).toHaveLength(9);
    expect(finished.points[1]).toBe(1 + 20 + 50 + 4 + 6 + 7 + 9 + 9 + 0);
    expect(finished.points[2]).toBe(1 + 2 + 3 + 4 + 6 + 7 + 8);
    expect(finished.points[0]).toBe(0);
    expect(finished.points[3]).toBe(0);
    expect(finished.lastEvents.map((e) => e.type)).toEqual(["played", "drew", "skipped"]);
  });

  it("refuses further actions once finished", () => {
    const finished = finishWithOneCard();
    expectRejected(finished, 1, { type: "draw" }, "wrong-phase");
  });

  it("handPoints sums card values", () => {
    expect(handPoints(cardsOf(["r0", "g7a", "bSa", "W4a"]))).toBe(77);
  });
});

describe("settle", () => {
  it("each loser pays round(points x stake / 10) to the winner; deltas sum to zero", () => {
    const finished = finishWithOneCard();
    const deltas = settle(finished);
    expect(deltas[1]).toBe(-paymentFor(106, 100));
    expect(deltas[2]).toBe(-paymentFor(31, 100));
    expect(deltas[0]).toBe(1060 + 310);
    expect(deltas[3]).toBe(0);
    expect(deltas[4]).toBe(0);
    expect(deltas[5]).toBe(0);
    expect(Object.values(deltas).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("rounds odd stakes to whole credits", () => {
    expect(paymentFor(31, 15)).toBe(47);
    expect(paymentFor(0, 15)).toBe(0);
    expect(paymentFor(106, 1)).toBe(11);
  });
});

describe("viewFor", () => {
  it("reveals only the viewer's hand mid-hand, with counts and the drawn-card id scoped to the drawer", () => {
    let s = playing(act(newGame(ENDGAME), 0, { type: "play", cardId: "g1a" }));
    s = playing(act(s, 1, { type: "draw" }, seeded())); // b* on green: drew r9a, not playable
    s = playing(act(s, 2, { type: "draw" })); // drew r0 -> not playable
    // Seat 0: green 2 playable; draw to test the decision flag.
    const drained = { ...s, drawPile: [...s.drawPile.slice(0, -1), cardsOf(["g9b"])[0]] };
    s = playing(act(drained, 0, { type: "draw" }));
    expect(s.pendingDraw).toBe("g9b");

    const mine = viewFor(s, 0);
    const theirs = viewFor(s, 1);
    const outsider = viewFor(s, 5);
    if (mine.phase !== "playing" || theirs.phase !== "playing" || outsider.phase !== "playing") {
      throw new Error("expected playing views");
    }
    expect(mine.hand.map((c) => c.id)).toContain("g9b");
    expect(mine.pendingDraw).toBe("g9b");
    expect(mine.awaitingDrawDecision).toBe(true);
    expect(theirs.pendingDraw).toBeNull();
    expect(theirs.awaitingDrawDecision).toBe(true);
    expect(theirs.hand.map((c) => c.id)).toEqual([...ENDGAME.hands[1], "r9a"]);
    expect(theirs.handCounts).toEqual({ 0: 7, 1: 8, 2: 8, 3: 0, 4: 0, 5: 0 });
    expect(outsider.hand).toEqual([]);
    expect(outsider.topCard.id).toBe("g1a");
    expect(outsider.currentColor).toBe("green");
    expect(outsider.drawPileCount).toBe(s.drawPile.length);
    expect(JSON.stringify(theirs)).not.toContain("g2a");
    expect(JSON.stringify(theirs)).not.toContain("drawPile\"");
  });

  it("exposes every hand once finished", () => {
    const finished = finishWithOneCard();
    const view = viewFor(finished, 2);
    expect(view.phase).toBe("finished");
    if (view.phase !== "finished") throw new Error("unreachable");
    expect(view.viewer).toBe(2);
    expect(view.hands[1]).toHaveLength(9);
    expect(view.winner).toBe(0);
  });
});
