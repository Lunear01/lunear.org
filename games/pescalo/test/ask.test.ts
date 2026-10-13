import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import { createGame, type GameState, type PlayingState, type Seat } from "../src/game";
import { ask, cardsOf, expectRejected, game, ids, playing } from "./helpers";

const HAND0 = ["7S", "7H", "9S", "JS", "QS", "KS", "AS"];
const HAND1 = ["7D", "8S", "8H", "JD", "QD", "KD", "AD"];

describe("rejections", () => {
  it("refuses out-of-turn, self or inactive targets, bad ranks, and ranks not held", () => {
    const state = game([0, 1], { 0: HAND0, 1: HAND1 });
    expectRejected(state, 1, { type: "ask", target: 0, rank: 7 }, "not-your-turn");
    expectRejected(state, 0, { type: "ask", target: 0, rank: 7 }, "invalid-target");
    expectRejected(state, 0, { type: "ask", target: 3, rank: 7 }, "invalid-target");
    expectRejected(state, 0, { type: "ask", target: 1, rank: 2 }, "invalid-rank");
    expectRejected(state, 0, { type: "ask", target: 1, rank: 7.5 }, "invalid-rank");
    expectRejected(state, 0, { type: "ask", target: 1, rank: 8 }, "rank-not-in-hand");
  });
});

describe("a hit", () => {
  it("moves every card of the rank to the asker, who goes again", () => {
    const next = playing(ask(game([0, 1], { 0: HAND0, 1: HAND1 }), 0, 1, 7));
    expect(ids(next.hands[0])).toEqual([...HAND0, "7D"]);
    expect(ids(next.hands[1])).toEqual(HAND1.filter((id) => id !== "7D"));
    expect(next.currentTurn).toBe(0);
    expect(next.lastEvents).toEqual([
      { type: "asked", seat: 0, target: 1, rank: 7 },
      { type: "hit", seat: 0, target: 1, rank: 7, count: 1 },
    ]);
  });

  it("forms a book when the fourth card arrives", () => {
    const state = game([0, 1], { 0: ["7S", "7H", "7D", "9S", "JS", "QS", "KS"], 1: ["7C", "8S", "8H", "JD", "QD", "KD", "AD"] });
    const next = playing(ask(state, 0, 1, 7));
    expect(ids(next.hands[0])).toEqual(["9S", "JS", "QS", "KS"]);
    expect(next.books[0]).toEqual([7]);
    expect(next.lastEvents.at(-1)).toEqual({ type: "book", seat: 0, rank: 7 });
    expect(next.currentTurn).toBe(0);
  });
});

describe("go fish", () => {
  it("draws a hidden card and passes the turn", () => {
    const next = playing(ask(game([0, 1], { 0: HAND0, 1: HAND1 }, ["3C"]), 0, 1, 9));
    expect(ids(next.hands[0])).toEqual([...HAND0, "3C"]);
    expect(next.pool).toHaveLength(52 - 14 - 1);
    expect(next.currentTurn).toBe(1);
    expect(next.lastEvents).toEqual([
      { type: "asked", seat: 0, target: 1, rank: 9 },
      { type: "go-fish", seat: 0, target: 1, rank: 9 },
      { type: "drew-hidden", seat: 0 },
    ]);
  });

  it("shows a drawn card of the asked rank and the asker goes again", () => {
    const next = playing(ask(game([0, 1], { 0: HAND0, 1: HAND1 }, ["9H"]), 0, 1, 9));
    expect(ids(next.hands[0])).toEqual([...HAND0, "9H"]);
    expect(next.currentTurn).toBe(0);
    expect(next.lastEvents.at(-1)).toEqual({ type: "drew-match", seat: 0, rank: 9 });
  });

  it("books a hidden draw that completes four, then passes the turn", () => {
    const state = game([0, 1], { 0: ["7S", "7H", "7D", "9S", "JS", "QS", "KS"], 1: HAND1.map((id) => (id === "7D" ? "3D" : id)) }, ["7C"]);
    const next = playing(ask(state, 0, 1, 9));
    expect(next.books[0]).toEqual([7]);
    expect(next.lastEvents.slice(-2)).toEqual([
      { type: "drew-hidden", seat: 0 },
      { type: "book", seat: 0, rank: 7 },
    ]);
    expect(next.currentTurn).toBe(1);
  });

  it("passes the turn without drawing when the pool is empty", () => {
    const state = emptyPoolState({ 0: ["7S", "9S"], 1: ["7H"], 2: ["JS"] }, 0);
    const next = playing(ask(state, 0, 2, 7));
    expect(next.currentTurn).toBe(1);
    expect(ids(next.hands[0])).toEqual(["7S", "9S"]);
    expect(next.lastEvents).toEqual([
      { type: "asked", seat: 0, target: 2, rank: 7 },
      { type: "go-fish", seat: 0, target: 2, rank: 7 },
    ]);
  });
});

describe("turn start", () => {
  it("refills an empty hand from the pool", () => {
    // Seat 1 holds only the 7D; seat 0's hit empties it, and when the turn
    // reaches seat 1 it draws the pool top before acting.
    const state = game([0, 1, 2], { 0: ["7S", "7H", "9S", "JS", "QS"], 1: ["7D", "8S", "8H", "8D", "8C"] }, ["3C", "4C"]);
    const afterHit = playing(ask(state, 0, 1, 7));
    expect(afterHit.hands[1]).toEqual([]);
    expect(afterHit.books[1]).toEqual([8]);
    const afterMiss = playing(ask(afterHit, 0, 2, 12));
    expect(afterMiss.currentTurn).toBe(1);
    expect(ids(afterMiss.hands[1])).toEqual(["4C"]);
    expect(afterMiss.lastEvents.at(-1)).toEqual({ type: "refill", seat: 1 });
  });

  it("skips an empty hand when the pool is empty too", () => {
    const state = emptyPoolState({ 0: ["7S", "9S"], 1: [], 2: ["7H"] }, 0);
    const next = playing(ask(state, 0, 2, 9));
    expect(next.currentTurn).toBe(2);
    expect(next.lastEvents.map((e) => e.type)).toEqual(["asked", "go-fish", "skipped"]);
  });

  it("finishes instead of looping when every book is made", () => {
    const books = { 0: [3, 4, 5, 6, 7, 8, 9], 1: [10, 11, 12, 13, 14, 15], 2: [] } as const;
    const state: GameState = { ...emptyPoolState({ 0: ["7S"], 1: [], 2: [] }, 0), books: { ...books, 3: [], 4: [] } };
    // One card short of a real deck, but the engine only counts books.
    const next = ask(state, 0, 1, 7);
    expect(next.phase).toBe("finished");
    if (next.phase !== "finished") throw new Error("unreachable");
    expect(next.winners).toEqual([0]);
  });
});

describe("finish", () => {
  it("ends once all 13 books exist and names the seats with the most", () => {
    let state: GameState = createGame({ shuffledDeck: createDeck(), activeSeats: [0, 1], firstSeat: 0, baseStake: 10 });
    let guard = 0;
    while (state.phase === "playing") {
      if (++guard > 500) throw new Error("game did not finish");
      const seat = state.currentTurn;
      state = ask(state, seat, otherSeat(seat), state.hands[seat][0].rank);
    }
    const total = state.books[0].length + state.books[1].length;
    expect(total).toBe(13);
    const most = Math.max(state.books[0].length, state.books[1].length);
    expect(state.winners).toEqual(([0, 1] as const).filter((s) => state.books[s].length === most));
    expectRejected(state, 0, { type: "ask", target: 1, rank: 7 }, "wrong-phase");
  });
});

// --- helpers ------------------------------------------------------------------

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

/** Three-seat mid-hand state with an empty pool, for the no-draw branches. */
function emptyPoolState(hands: Record<0 | 1 | 2, readonly string[]>, currentTurn: Seat): PlayingState {
  return {
    phase: "playing",
    activeSeats: [0, 1, 2],
    baseStake: 10,
    hands: { 0: cardsOf(hands[0]), 1: cardsOf(hands[1]), 2: cardsOf(hands[2]), 3: [], 4: [] },
    pool: [],
    books: { 0: [], 1: [], 2: [], 3: [], 4: [] },
    currentTurn,
    lastEvents: [],
  };
}
