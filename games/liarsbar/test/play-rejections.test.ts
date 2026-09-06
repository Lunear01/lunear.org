import { describe, expect, it } from "vitest";
import { applyAction, createGame, type PlayingState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

function newGame(firstSeat: 0 | 1 | 2 | 3 = 0): PlayingState {
  const deck = buildRoundDeck({ 0: ["Q1", "Q2", "K1"], 1: ["A1"] });
  return createGame({
    shuffledDeck: deck,
    tableRank: "Q",
    bulletPositions: bulletPositions(6), // nobody dies accidentally mid-test
    firstSeat,
    baseStake: 10,
  });
}

describe("play rejections", () => {
  it("rejects an empty card selection", () => {
    const state = newGame(0);
    expect(applyAction(state, 0, { type: "play", cardIds: [] })).toEqual({ ok: false, reason: "empty-play" });
  });

  it("rejects a play of more than 3 cards", () => {
    const state = newGame(0);
    // seat 0's hand: Q1, Q2, K1 + 2 filler = 5 cards; take any 4 ids from it.
    const fourIds = state.hands[0].slice(0, 4).map((c) => c.id);
    expect(applyAction(state, 0, { type: "play", cardIds: fourIds })).toEqual({
      ok: false,
      reason: "too-many-cards",
    });
  });

  it("accepts exactly 1, 2, or 3 cards", () => {
    expect(applyAction(newGame(0), 0, { type: "play", cardIds: ["Q1"] }).ok).toBe(true);
    expect(applyAction(newGame(0), 0, { type: "play", cardIds: ["Q1", "Q2"] }).ok).toBe(true);
    expect(applyAction(newGame(0), 0, { type: "play", cardIds: ["Q1", "Q2", "K1"] }).ok).toBe(true);
  });

  it("rejects duplicate card ids in one play", () => {
    const state = newGame(0);
    const result = applyAction(state, 0, { type: "play", cardIds: ["Q1", "Q1"] });
    expect(result).toEqual({ ok: false, reason: "invalid-cards" });
  });

  it("rejects cards not held in hand", () => {
    const state = newGame(0);
    const result = applyAction(state, 0, { type: "play", cardIds: ["A1"] }); // held by seat 1, not seat 0
    expect(result).toEqual({ ok: false, reason: "cards-not-in-hand" });
  });

  it("rejects an action from a seat whose turn it is not", () => {
    const state = newGame(0);
    const result = applyAction(state, 1, { type: "play", cardIds: ["A1"] });
    expect(result).toEqual({ ok: false, reason: "not-your-turn" });
  });

  it("rejects a challenge when there is nothing pending", () => {
    const state = newGame(0);
    expect(state.lastPlay).toBeNull();
    const result = applyAction(state, 0, { type: "challenge" });
    expect(result).toEqual({ ok: false, reason: "nothing-to-challenge" });
  });

  it("allows a challenge once a play is pending", () => {
    let state = newGame(0);
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1"] });
    expect(played.ok).toBe(true);
    state = (played as { ok: true; state: PlayingState }).state;
    expect(state.lastPlay).not.toBeNull();
    const challenge = applyAction(state, state.currentTurn, { type: "challenge" });
    expect(challenge.ok).toBe(true);
  });

  it("rejects any action once the game has left the playing phase (roundEnd)", () => {
    let state = newGame(0);
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1"] }); // truthful
    state = (played as { ok: true; state: PlayingState }).state;
    const challenged = applyAction(state, state.currentTurn, { type: "challenge" });
    expect(challenged.ok).toBe(true);
    if (!challenged.ok) throw new Error("unreachable");
    expect(challenged.state.phase).toBe("roundEnd");
    const result = applyAction(challenged.state, 0, { type: "play", cardIds: ["Q2"] });
    expect(result).toEqual({ ok: false, reason: "wrong-phase" });
  });
});
