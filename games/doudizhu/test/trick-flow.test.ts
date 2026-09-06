import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import { applyAction, createGame, type PlayingState } from "../src/game";

/**
 * Landlord (seat 0) holds a rank-8 single opener and a bomb of 7s.
 * Seat 1 holds a rank-4 single (too low to beat the opener).
 * Everything else is unconstrained filler, split from the remaining deck.
 */
function buildPlayingState(): PlayingState {
  const deck = createDeck();
  const byId = new Map(deck.map((c) => [c.id, c]));
  const reserved = ["8S", "7S", "7H", "7D", "7C", "4S"];
  const filler = deck.map((c) => c.id).filter((id) => !reserved.includes(id));

  const seat0 = [...reserved.slice(0, 5), ...filler.slice(0, 12)]; // 17: 8S + bomb + 12 filler
  const seat1 = [reserved[5], ...filler.slice(12, 28)]; // 17: 4S + 16 filler
  const seat2 = filler.slice(28, 45); // 17 filler
  const landlordCards = filler.slice(45, 48); // 3 filler

  const order = [...seat0, ...seat1, ...seat2, ...landlordCards].map((id) => byId.get(id)!);
  const bidding = createGame({ shuffledDeck: order, firstBidder: 0, baseStake: 100 });
  const result = applyAction(bidding, 0, { type: "bid", amount: 3 });
  if (!result.ok || result.state.phase !== "playing") throw new Error("test setup failed");
  return result.state;
}

describe("trick flow", () => {
  it("a player with the free lead cannot pass", () => {
    const state = buildPlayingState();
    expect(state.lastPlay).toBeNull();
    const result = applyAction(state, 0, { type: "pass" });
    expect(result).toEqual({ ok: false, reason: "cannot-pass-on-lead" });
  });

  it("rejects a play that does not beat the previous play", () => {
    let state = buildPlayingState();
    const lead = applyAction(state, 0, { type: "play", cardIds: ["8S"] });
    expect(lead.ok).toBe(true);
    state = (lead as { ok: true; state: PlayingState }).state;
    expect(state.currentTurn).toBe(1);

    const tooLow = applyAction(state, 1, { type: "play", cardIds: ["4S"] });
    expect(tooLow).toEqual({ ok: false, reason: "must-beat-previous" });
  });

  it("double pass clears the trick back to the last player who played", () => {
    let state = buildPlayingState();
    let result = applyAction(state, 0, { type: "play", cardIds: ["8S"] });
    state = (result as { ok: true; state: PlayingState }).state;

    result = applyAction(state, 1, { type: "pass" });
    expect(result.ok).toBe(true);
    state = (result as { ok: true; state: PlayingState }).state;
    expect(state.passCountInRow).toBe(1);
    expect(state.lastPlay).not.toBeNull();

    result = applyAction(state, 2, { type: "pass" });
    expect(result.ok).toBe(true);
    state = (result as { ok: true; state: PlayingState }).state;
    expect(state.lastPlay).toBeNull(); // trick cleared
    expect(state.passCountInRow).toBe(0);
    expect(state.currentTurn).toBe(0); // seat 0 led the winning play, leads again
  });

  it("the re-leading player may play any legal combo, e.g. a bomb, as a fresh lead", () => {
    let state = buildPlayingState();
    let result = applyAction(state, 0, { type: "play", cardIds: ["8S"] });
    state = (result as { ok: true; state: PlayingState }).state;
    result = applyAction(state, 1, { type: "pass" });
    state = (result as { ok: true; state: PlayingState }).state;
    result = applyAction(state, 2, { type: "pass" });
    state = (result as { ok: true; state: PlayingState }).state;

    result = applyAction(state, 0, { type: "play", cardIds: ["7S", "7H", "7D", "7C"] });
    expect(result.ok).toBe(true);
    state = (result as { ok: true; state: PlayingState }).state;
    expect(state.bombCount).toBe(1);
    expect(state.currentTurn).toBe(1);
  });

  it("rejects an action from a seat whose turn it is not", () => {
    const state = buildPlayingState();
    const result = applyAction(state, 1, { type: "play", cardIds: ["4S"] });
    expect(result).toEqual({ ok: false, reason: "not-your-turn" });
  });

  it("rejects playing cards not held in hand", () => {
    const state = buildPlayingState();
    const result = applyAction(state, 0, { type: "play", cardIds: ["4S"] }); // held by seat 1, not seat 0
    expect(result).toEqual({ ok: false, reason: "cards-not-in-hand" });
  });

  it("rejects an illegal shape as an invalid play", () => {
    const state = buildPlayingState();
    const result = applyAction(state, 0, { type: "play", cardIds: ["8S", "7S"] }); // unrelated ranks
    expect(result).toEqual({ ok: false, reason: "invalid-cards" });
  });

  it("rejects a bid action once play has started", () => {
    const state = buildPlayingState();
    const result = applyAction(state, 0, { type: "bid", amount: 1 });
    expect(result).toEqual({ ok: false, reason: "wrong-phase" });
  });

  it("rejects an empty card selection as a play", () => {
    const state = buildPlayingState();
    const result = applyAction(state, 0, { type: "play", cardIds: [] });
    expect(result).toEqual({ ok: false, reason: "empty-play" });
  });
});
