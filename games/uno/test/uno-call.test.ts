import { describe, expect, it } from "vitest";
import { viewFor } from "../src/game";
import { act, expectRejected, ids, newGame, playing, seeded } from "./helpers";

// Three seats. Seat 0 holds two green cards and sheds down to one on its
// first play; seat 1 and 2 hold only blues and yellows, so on green they
// can only draw.
const SCRIPT = {
  hands: {
    0: ["g1a", "g2a", "g3a", "g4a", "g6a", "g7a", "gDa"],
    1: ["b1a", "b2a", "b3a", "b4a", "b6a", "b7a", "b8a"],
    2: ["y1a", "y2a", "y3a", "y4a", "y6a", "y7a", "y8a"],
  },
  flips: ["g5a"],
  draws: ["r9a", "r0", "r1a", "r2a", "r3a", "r4a"],
} as const;

/** Seat 0 down to two cards (g1a, g2a), its turn, green on top. */
function twoCardsLeft() {
  const start = newGame(SCRIPT);
  return { ...start, hands: { ...start.hands, 0: start.hands[0].slice(0, 2) } };
}

describe("call UNO with the play", () => {
  it("marks the seat called and not vulnerable", () => {
    const s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a", uno: true }));
    expect(s.hands[0]).toHaveLength(1);
    expect(s.unoCalled).toEqual([0]);
    expect(s.unoVulnerable).toBeNull();
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played", "called-uno"]);
    expectRejected(s, 1, { type: "catchUno", target: 0 }, "nothing-to-catch");
  });

  it("ignores the flag when more than one card remains", () => {
    const s = playing(act(newGame(SCRIPT), 0, { type: "play", cardId: "g1a", uno: true }));
    expect(s.unoCalled).toEqual([]);
    expect(s.unoVulnerable).toBeNull();
    expect(s.lastEvents.map((e) => e.type)).toEqual(["played"]);
  });
});

describe("call UNO afterwards", () => {
  it("a vulnerable seat may call from any seat's turn and stops being catchable", () => {
    let s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    expect(s.unoVulnerable).toBe(0);
    expect(s.currentTurn).toBe(1);
    s = playing(act(s, 0, { type: "callUno" }));
    expect(s.unoVulnerable).toBeNull();
    expect(s.unoCalled).toEqual([0]);
    expect(s.lastEvents).toEqual([{ type: "called-uno", seat: 0 }]);
    expect(s.currentTurn).toBe(1);
    expectRejected(s, 1, { type: "catchUno", target: 0 }, "nothing-to-catch");
  });

  it("is refused without exactly one card, or twice", () => {
    expectRejected(twoCardsLeft(), 0, { type: "callUno" }, "cannot-call-uno");
    expectRejected(twoCardsLeft(), 1, { type: "callUno" }, "cannot-call-uno");
    expectRejected(twoCardsLeft(), 5, { type: "callUno" }, "cannot-call-uno");
    const s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a", uno: true }));
    expectRejected(s, 0, { type: "callUno" }, "cannot-call-uno");
  });
});

describe("catch", () => {
  it("makes the vulnerable seat draw two and clears vulnerability", () => {
    let s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    s = playing(act(s, 2, { type: "catchUno", target: 0 }));
    expect(ids(s.hands[0])).toEqual(["g2a", "r9a", "r0"]);
    expect(s.unoVulnerable).toBeNull();
    expect(s.unoCalled).toEqual([]);
    expect(s.currentTurn).toBe(1);
    expect(s.lastEvents).toEqual([
      { type: "caught", seat: 0, by: 2 },
      { type: "drew", seat: 0, count: 2 },
    ]);
    expectRejected(s, 1, { type: "catchUno", target: 0 }, "nothing-to-catch");
  });

  it("reshuffles the discards through the RNG when the draw pile is empty", () => {
    let s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    const dry = { ...s, drawPile: [], discardPile: [...s.discardPile.slice(0, -1), ...s.drawPile.slice(0, 3), s.discardPile[s.discardPile.length - 1]] };
    s = playing(act(dry, 1, { type: "catchUno", target: 0 }, seeded()));
    expect(s.hands[0]).toHaveLength(3);
    expect(s.discardPile.map((c) => c.id)).toEqual(["g1a"]);
    expect(s.lastEvents.map((e) => e.type)).toEqual(["caught", "reshuffled", "drew"]);
  });

  it("is refused by the target itself, by a bystander, and when nobody is vulnerable", () => {
    const s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    expectRejected(s, 0, { type: "catchUno", target: 0 }, "nothing-to-catch");
    expectRejected(s, 5, { type: "catchUno", target: 0 }, "nothing-to-catch");
    expectRejected(s, 1, { type: "catchUno", target: 1 }, "nothing-to-catch");
    expectRejected(twoCardsLeft(), 1, { type: "catchUno", target: 0 }, "nothing-to-catch");
  });
});

describe("window", () => {
  it("closes on the next play, draw, or pass", () => {
    const vulnerable = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));

    // Draw: r9a is unplayable on green, so the turn moves on; the window is shut either way.
    const afterDraw = playing(act(vulnerable, 1, { type: "draw" }));
    expect(afterDraw.currentTurn).toBe(2);
    expect(afterDraw.unoVulnerable).toBeNull();
    expectRejected(afterDraw, 2, { type: "catchUno", target: 0 }, "nothing-to-catch");

    // Play: hand seat 1 a green 2 so it can play on green.
    const canPlay = { ...vulnerable, hands: { ...vulnerable.hands, 1: [...vulnerable.hands[1], vulnerable.hands[0][0]] } };
    const afterPlay = playing(act(canPlay, 1, { type: "play", cardId: "g2a" }));
    expect(afterPlay.unoVulnerable).toBeNull();

    // Pass: put a green 2 on top of the draw pile so seat 1 draws a playable card, then passes.
    const playableTop = { ...vulnerable, drawPile: [...vulnerable.drawPile.slice(0, -1), vulnerable.hands[0][0]] };
    const drawn = playing(act(playableTop, 1, { type: "draw" }));
    expect(drawn.pendingDraw).toBe("g2a");
    expect(drawn.unoVulnerable).toBeNull();
    const afterPass = playing(act(drawn, 1, { type: "pass" }));
    expect(afterPass.unoVulnerable).toBeNull();
  });

  it("a vulnerable seat that plays its last card wins", () => {
    const vulnerable = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    // Hand the turn straight back to seat 0 by making seats 1 and 2 draw.
    let s = playing(act(vulnerable, 1, { type: "draw" }));
    s = playing(act(s, 2, { type: "draw" }));
    expect(s.currentTurn).toBe(0);
    const finished = act(s, 0, { type: "play", cardId: "g2a" });
    expect(finished.phase).toBe("finished");
    if (finished.phase !== "finished") throw new Error("unreachable");
    expect(finished.winner).toBe(0);
  });
});

describe("called badge", () => {
  it("resets once the called hand grows past one card", () => {
    let s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a", uno: true }));
    s = playing(act(s, 1, { type: "draw" }));
    s = playing(act(s, 2, { type: "draw" }));
    expect(s.unoCalled).toEqual([0]);
    s = playing(act(s, 0, { type: "draw" }));
    expect(s.hands[0]).toHaveLength(2);
    expect(s.unoCalled).toEqual([]);
  });

  it("a draw-two penalty also clears the badge", () => {
    const start = newGame(SCRIPT);
    // Seat 2 sits on one card, already called; seat 1 holds a green draw-two aimed at it.
    const s0 = {
      ...start,
      hands: { ...start.hands, 1: [...start.hands[1], start.hands[0][6]], 2: start.hands[2].slice(0, 1) },
      unoCalled: [2 as const],
    };
    let s = playing(act(s0, 0, { type: "play", cardId: "g1a" }));
    expect(s.unoCalled).toEqual([2]);
    s = playing(act(s, 1, { type: "play", cardId: "gDa" }));
    expect(s.hands[2]).toHaveLength(3);
    expect(s.unoCalled).toEqual([]);
  });

  it("views carry the vulnerable seat and called seats publicly", () => {
    const s = playing(act(twoCardsLeft(), 0, { type: "play", cardId: "g1a" }));
    const v = viewFor(s, 2);
    if (v.phase !== "playing") throw new Error("unreachable");
    expect(v.unoVulnerable).toBe(0);
    expect(v.unoCalled).toEqual([]);
  });
});
