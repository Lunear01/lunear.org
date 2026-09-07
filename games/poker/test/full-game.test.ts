import { describe, expect, it } from "vitest";
import { createGame, settle, type FinishedState, type GameState, type ShowdownState } from "../src/game";
import { act, buildDeck } from "./helpers";

function sumDeltas(deltas: Readonly<Record<number, number>>): number {
  return Object.values(deltas).reduce((a, b) => a + b, 0);
}

describe("full scripted hand: 3-way showdown with an exact-tie split pot", () => {
  it("seat0 loses with a plain pair; seat1 and seat2 tie for trip kings and split the odd pot, extra chip to the earlier seat clockwise from the dealer", () => {
    const seats = [0, 1, 2];
    const dealerSeat = 0;
    // Community: a paired-kings board that's otherwise disconnected (no straight, no flush).
    // Board alone gives every player at least a pair of kings.
    const community = ["Kh", "Kd", "7c", "4s", "2h"];
    const deck = buildDeck(seats, {
      hole: {
        0: ["6h", "5c"], // no help from the board -> stuck with plain pair of kings (worse category)
        1: ["Kc", "3d"], // 3rd king -> trips, kickers settle on the board's 7 and 4 (3d is too low to matter)
        2: ["Ks", "3c"], // 4th king -> trips, same kickers (3c is too low to matter, and doesn't pair the board's 2)
      },
      community,
    });

    // stake=1 keeps the pot small and, crucially, ODD (3 chips split 2 ways) so the odd-chip rule
    // is actually exercised — small blind floor(1/2)=0 rounds up to the minimum of 1, so SB==BB==1.
    let state: GameState = createGame({ seats, dealerSeat, stake: 1, shuffledDeck: deck });

    // Preflop: UTG (== dealer in a 3-handed game) calls; SB and BB already match the 1-chip bet
    // and just take their check option.
    expect((state as { currentTurn: number }).currentTurn).toBe(0);
    state = act(state, 0, { type: "call" });
    state = act(state, 1, { type: "check" });
    state = act(state, 2, { type: "check" });
    expect(state.phase).toBe("flop");

    // Flop, turn, river: everyone checks it down (SB acts first postflop each street).
    for (let street = 0; street < 3; street++) {
      state = act(state, 1, { type: "check" });
      state = act(state, 2, { type: "check" });
      state = act(state, 0, { type: "check" });
    }

    expect(state.phase).toBe("showdown");
    const showdown = state as ShowdownState;
    expect(showdown.community.map((c) => c.id).sort()).toEqual(community.slice().sort());
    expect(showdown.pot).toBe(3);

    const resultBySeat = new Map(showdown.results.map((r) => [r.seat, r.hand]));
    expect(resultBySeat.get(0)!.category).toBe("pair");
    expect(resultBySeat.get(1)!.category).toBe("trips");
    expect(resultBySeat.get(2)!.category).toBe("trips");
    expect(resultBySeat.get(1)!.ranks).toEqual(resultBySeat.get(2)!.ranks); // exact tie

    expect(showdown.winners.slice().sort()).toEqual([1, 2]);
    expect(showdown.amountWon).toEqual({ 0: 0, 1: 2, 2: 1 }); // 1 each base, odd chip to seat 1 (earlier, clockwise from dealer 0)

    const deltas = settle(showdown);
    expect(deltas).toEqual({ 0: -1, 1: 1, 2: 0 });
    expect(sumDeltas(deltas)).toBe(0);
  });
});

describe("full scripted hand: fold-out preflop win", () => {
  it("everyone but the big blind folds preflop; the big blind wins the blinds uncontested, no board is dealt", () => {
    const seats = [0, 1, 2, 3];
    const dealerSeat = 1;
    const deck = buildDeck(seats, {});
    let state: GameState = createGame({ seats, dealerSeat, stake: 10, shuffledDeck: deck });

    // dealer=1 -> SB=2, BB=3, UTG=0. toAct order: [0, 1, 2, 3].
    expect((state as { currentTurn: number }).currentTurn).toBe(0);
    state = act(state, 0, { type: "fold" }); // UTG folds, contributed nothing
    expect(state.phase).not.toBe("finished");
    state = act(state, 1, { type: "fold" }); // dealer folds, contributed nothing
    expect(state.phase).not.toBe("finished");
    state = act(state, 2, { type: "fold" }); // SB folds, forfeiting their 5-chip blind

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.winner).toBe(3);
    expect(finished.community.length).toBe(0); // no reveal, no board dealt
    expect(finished.pot).toBe(15); // SB's 5 + BB's 10

    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: 0, 1: 0, 2: -5, 3: 5 });
    expect(sumDeltas(deltas)).toBe(0);

    // A finished hand accepts no further actions.
    expect(finished.phase).toBe("finished");
  });
});

describe("full scripted hand: heads-up all-in runout", () => {
  it("both players shove preflop; the board runs out with no further betting and the better hand scoops it all", () => {
    const seats = [0, 1];
    const dealerSeat = 0;
    const community = ["2c", "5d", "9s", "Jc", "3h"]; // disconnected: helps neither pocket pair
    const deck = buildDeck(seats, {
      hole: { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"] },
      community,
    });
    let state: GameState = createGame({ seats, dealerSeat, stake: 10, shuffledDeck: deck });

    // Heads-up: dealer (seat 0) is the small blind and acts first preflop.
    expect((state as { currentTurn: number }).currentTurn).toBe(0);
    state = act(state, 0, { type: "raise", toAmount: 1000 }); // shove (100x stake)
    state = act(state, 1, { type: "call" }); // calls all-in

    // Nobody has any chips left to act with -> flop/turn/river are dealt with no more betting.
    expect(state.phase).toBe("showdown");
    const showdown = state as ShowdownState;
    expect(showdown.community.map((c) => c.id).sort()).toEqual(community.slice().sort());
    expect(showdown.players[0].committed).toBe(1000);
    expect(showdown.players[1].committed).toBe(1000);
    expect(showdown.pot).toBe(2000);

    const resultBySeat = new Map(showdown.results.map((r) => [r.seat, r.hand]));
    expect(resultBySeat.get(0)!.category).toBe("pair");
    expect(resultBySeat.get(0)!.ranks[0]).toBe(14); // pair of aces
    expect(resultBySeat.get(1)!.ranks[0]).toBe(13); // pair of kings
    expect(showdown.winners).toEqual([0]);
    expect(showdown.amountWon).toEqual({ 0: 2000, 1: 0 });

    const deltas = settle(showdown);
    expect(deltas).toEqual({ 0: 1000, 1: -1000 });
    expect(sumDeltas(deltas)).toBe(0);
  });
});
