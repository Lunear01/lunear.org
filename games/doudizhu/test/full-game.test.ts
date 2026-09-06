import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import type { Seat } from "../src/deal";
import { applyAction, createGame, settle, type Action, type FinishedState, type GameState } from "../src/game";
import { buildDealOrder } from "./helpers";

/** Apply an action, throwing with the rejection reason if it's unexpectedly refused. */
function play(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    throw new Error(`applyAction rejected: ${result.reason} (seat ${seat}, ${JSON.stringify(action)})`);
  }
  return result.state;
}

function fillerIds(exclude: readonly string[]): string[] {
  const excluded = new Set(exclude);
  return createDeck()
    .map((c) => c.id)
    .filter((id) => !excluded.has(id));
}

describe("full scripted game: deal -> bid -> play -> settle, with a bomb", () => {
  it("produces the exact expected per-seat deltas, summing to zero", () => {
    // Landlord (seat 0) ends up holding all of ranks 3-7 across all 4 suits (20 cards):
    // a single 3S, a bomb of 7s, and three straights (8-Q) in S/H/D.
    const landlordAll20 = [
      "3S",
      "7S",
      "7H",
      "7D",
      "7C",
      "8S",
      "9S",
      "10S",
      "JS",
      "QS",
      "8H",
      "9H",
      "10H",
      "JH",
      "QH",
      "8D",
      "9D",
      "10D",
      "JD",
      "QD",
    ];
    const farmer1Card = "4S"; // beats the landlord's opening single
    const filler = fillerIds([...landlordAll20, farmer1Card]);
    const seat1 = [farmer1Card, ...filler.slice(0, 16)];
    const seat2 = filler.slice(16, 33);

    const deck = buildDealOrder({
      seat0: landlordAll20.slice(0, 17),
      seat1,
      seat2,
      landlordCards: landlordAll20.slice(17, 20),
    });

    let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: 100 });

    // Bidding: seat 0 bids 2, others pass -> seat 0 is landlord at multiplier 2.
    state = play(state, 0, { type: "bid", amount: 2 });
    state = play(state, 1, { type: "pass" });
    state = play(state, 2, { type: "pass" });
    expect(state.phase).toBe("playing");
    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.landlord).toBe(0);
    expect(state.bidMultiplierBase).toBe(2);

    // Trick 1: landlord opens low, farmer 1 beats it, farmer 2 and landlord pass it out.
    state = play(state, 0, { type: "play", cardIds: ["3S"] });
    state = play(state, 1, { type: "play", cardIds: [farmer1Card] });
    state = play(state, 2, { type: "pass" });
    state = play(state, 0, { type: "play", cardIds: ["7S", "7H", "7D", "7C"] }); // bomb reclaims the trick
    state = play(state, 1, { type: "pass" });
    state = play(state, 2, { type: "pass" }); // double pass clears; landlord leads again

    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.lastPlay).toBeNull();
    expect(state.currentTurn).toBe(0);
    expect(state.bombCount).toBe(1);

    // Landlord clears the rest of their hand across three uncontested straights.
    state = play(state, 0, { type: "play", cardIds: ["8S", "9S", "10S", "JS", "QS"] });
    state = play(state, 1, { type: "pass" });
    state = play(state, 2, { type: "pass" });

    state = play(state, 0, { type: "play", cardIds: ["8H", "9H", "10H", "JH", "QH"] });
    state = play(state, 1, { type: "pass" });
    state = play(state, 2, { type: "pass" });

    state = play(state, 0, { type: "play", cardIds: ["8D", "9D", "10D", "JD", "QD"] }); // empties the hand

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.winner).toBe("landlord");
    expect(finished.bombCount).toBe(1);
    expect(finished.isSpring).toBe(false); // farmer 1 played once
    expect(finished.isAntiSpring).toBe(false);
    expect(finished.bidMultiplierBase).toBe(2);

    // pointsPerShare = 100 (stake) x 2 (bid) x 2^1 (one bomb) x 1 (no spring) = 400
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: 800, 1: -400, 2: -400 });
    expect(deltas[0] + deltas[1] + deltas[2]).toBe(0);

    // A finished game accepts no further actions.
    expect(applyAction(finished, 1, { type: "pass" })).toEqual({ ok: false, reason: "wrong-phase" });
  });
});

describe("spring: landlord empties their hand and farmers never play", () => {
  it("doubles the multiplier and produces the exact expected deltas", () => {
    // Landlord ends up with every card of ranks 3-7 (all 4 suits) -> four straights,
    // one per suit, enough to clear the whole hand without a farmer ever getting to play.
    const landlordAll20 = [
      "3S", "3H", "3D", "3C",
      "4S", "4H", "4D", "4C",
      "5S", "5H", "5D", "5C",
      "6S", "6H", "6D", "6C",
      "7S", "7H", "7D", "7C",
    ];
    const filler = fillerIds(landlordAll20);
    const seat1 = filler.slice(0, 17);
    const seat2 = filler.slice(17, 34);

    const deck = buildDealOrder({
      seat0: landlordAll20.slice(0, 17),
      seat1,
      seat2,
      landlordCards: landlordAll20.slice(17, 20),
    });

    let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: 50 });
    state = play(state, 0, { type: "bid", amount: 3 }); // short-circuits bidding

    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.landlord).toBe(0);
    expect(state.bidMultiplierBase).toBe(3);

    const suitStraights = [
      ["3S", "4S", "5S", "6S", "7S"],
      ["3H", "4H", "5H", "6H", "7H"],
      ["3D", "4D", "5D", "6D", "7D"],
      ["3C", "4C", "5C", "6C", "7C"],
    ];
    for (const straight of suitStraights) {
      state = play(state, 0, { type: "play", cardIds: straight });
      if (state.phase === "finished") break;
      state = play(state, 1, { type: "pass" });
      state = play(state, 2, { type: "pass" });
    }

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.winner).toBe("landlord");
    expect(finished.isSpring).toBe(true);
    expect(finished.isAntiSpring).toBe(false);
    expect(finished.bombCount).toBe(0);

    // pointsPerShare = 50 x 3 (bid) x 2^0 x 2 (spring) = 300
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: 600, 1: -300, 2: -300 });
    expect(deltas[0] + deltas[1] + deltas[2]).toBe(0);
  });
});

describe("anti-spring: landlord plays exactly once and loses", () => {
  it("doubles the multiplier and produces the exact expected deltas", () => {
    const landlordOpener = "3S";
    const farmer1Cards = [
      "4S", // beats the landlord's opener
      "5H", "6H", "7H", "8H", "9H",
      "5D", "6D", "7D", "8D", "9D",
      "5C", "6C", "7C", "8C", "9C",
      "10S",
    ];
    const filler = fillerIds([landlordOpener, ...farmer1Cards]);
    const landlordFiller = filler.slice(0, 19);
    const seat2 = filler.slice(19, 36);

    const deck = buildDealOrder({
      seat0: [landlordOpener, ...landlordFiller].slice(0, 17),
      seat1: farmer1Cards,
      seat2,
      landlordCards: [landlordOpener, ...landlordFiller].slice(17, 20),
    });

    let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: 100 });
    state = play(state, 0, { type: "bid", amount: 3 });

    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.landlord).toBe(0);

    // Landlord's one and only play.
    state = play(state, 0, { type: "play", cardIds: [landlordOpener] });
    state = play(state, 1, { type: "play", cardIds: ["4S"] }); // farmer 1 beats it
    state = play(state, 2, { type: "pass" });
    state = play(state, 0, { type: "pass" }); // landlord never plays again from here on
    if (state.phase !== "playing") throw new Error("unreachable");
    expect(state.currentTurn).toBe(1); // trick cleared back to farmer 1

    const farmer1Straights = [
      ["5H", "6H", "7H", "8H", "9H"],
      ["5D", "6D", "7D", "8D", "9D"],
      ["5C", "6C", "7C", "8C", "9C"],
    ];
    for (const straight of farmer1Straights) {
      state = play(state, 1, { type: "play", cardIds: straight });
      state = play(state, 2, { type: "pass" });
      state = play(state, 0, { type: "pass" });
    }
    state = play(state, 1, { type: "play", cardIds: ["10S"] }); // empties farmer 1's hand

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.winner).toBe("farmers");
    expect(finished.isAntiSpring).toBe(true);
    expect(finished.isSpring).toBe(false);
    expect(finished.bombCount).toBe(0);
    expect(finished.bidMultiplierBase).toBe(3);

    // pointsPerShare = 100 x 3 (bid) x 2^0 x 2 (anti-spring) = 600
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: -1200, 1: 600, 2: 600 });
    expect(deltas[0] + deltas[1] + deltas[2]).toBe(0);
  });
});

describe("settle: reads baseStake from state, not from a caller-supplied parameter", () => {
  it("two states differing only in baseStake produce proportionally different deltas", () => {
    const finishedAt10: FinishedState = {
      phase: "finished",
      landlord: 0,
      landlordCards: [],
      winner: "landlord",
      bombCount: 1,
      isSpring: false,
      isAntiSpring: false,
      bidMultiplierBase: 2,
      baseStake: 10,
      history: [],
    };
    const finishedAt30: FinishedState = { ...finishedAt10, baseStake: 30 };

    const deltasAt10 = settle(finishedAt10);
    const deltasAt30 = settle(finishedAt30);

    // Tripling baseStake (10 -> 30) must triple every seat's delta, with no way
    // to pass a mismatched stake since settle no longer takes one as an argument.
    expect(deltasAt30[0]).toBe(deltasAt10[0] * 3);
    expect(deltasAt30[1]).toBe(deltasAt10[1] * 3);
    expect(deltasAt30[2]).toBe(deltasAt10[2] * 3);
    expect(deltasAt10).toEqual({ 0: 80, 1: -40, 2: -40 });
    expect(deltasAt30).toEqual({ 0: 240, 1: -120, 2: -120 });
  });
});
