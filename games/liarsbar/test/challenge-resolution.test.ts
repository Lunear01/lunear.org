import { describe, expect, it } from "vitest";
import { applyAction, createGame, type PlayingState, type RoundEndState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

/** Seat 0 plays `playCardIds` under `tableRank`; seat 1 immediately challenges. Nobody dies
 * (chamber 6, so a single spin never matches) so the resulting reveal can be inspected in isolation. */
function playThenChallenge(tableRank: "Q" | "K" | "A", playCardIds: string[]): RoundEndState {
  const deck = buildRoundDeck({ 0: playCardIds });
  const state = createGame({
    shuffledDeck: deck,
    tableRank,
    bulletPositions: bulletPositions(6),
    firstSeat: 0,
    baseStake: 10,
  });
  const played = applyAction(state, 0, { type: "play", cardIds: playCardIds });
  if (!played.ok) throw new Error(`play rejected: ${played.reason}`);
  const playingState = played.state as PlayingState;
  const challenged = applyAction(playingState, playingState.currentTurn, { type: "challenge" });
  if (!challenged.ok) throw new Error(`challenge rejected: ${challenged.reason}`);
  return challenged.state as RoundEndState;
}

describe("truthful claim: every card matches the table rank", () => {
  it("the challenger spins, not the player", () => {
    const state = playThenChallenge("Q", ["Q1", "Q2"]);
    expect(state.lastReveal.wasTruthful).toBe(true);
    expect(state.lastReveal.loserSeat).toBe(state.lastReveal.challengerSeat);
    expect(state.lastReveal.challengerSeat).toBe(1);
    expect(state.lastReveal.playSeat).toBe(0);
  });
});

describe("lying claim: at least one card does not match the table rank and is not a joker", () => {
  it("the liar (original player) spins, not the challenger", () => {
    const state = playThenChallenge("Q", ["K1"]);
    expect(state.lastReveal.wasTruthful).toBe(false);
    expect(state.lastReveal.loserSeat).toBe(state.lastReveal.playSeat);
    expect(state.lastReveal.loserSeat).toBe(0);
  });
});

describe("joker wildness", () => {
  it("an all-joker play is truthful regardless of table rank", () => {
    const state = playThenChallenge("K", ["JOKER1", "JOKER2"]);
    expect(state.lastReveal.wasTruthful).toBe(true);
    expect(state.lastReveal.loserSeat).toBe(1); // challenger
  });

  it("a joker mixed with a true table-rank card is truthful", () => {
    const state = playThenChallenge("A", ["A1", "JOKER1"]);
    expect(state.lastReveal.wasTruthful).toBe(true);
    expect(state.lastReveal.loserSeat).toBe(1); // challenger
  });

  it("a joker mixed with a wrong-rank card is a lie", () => {
    const state = playThenChallenge("A", ["A1", "JOKER1", "K1"]);
    expect(state.lastReveal.wasTruthful).toBe(false);
    expect(state.lastReveal.loserSeat).toBe(0); // the player who bluffed
  });
});

describe("reveal record contents", () => {
  it("carries the actual revealed cards and is not marked auto", () => {
    const state = playThenChallenge("Q", ["Q1", "Q2", "Q3"]);
    expect(state.lastReveal.cards.map((c) => c.id).sort()).toEqual(["Q1", "Q2", "Q3"]);
    expect(state.lastReveal.auto).toBe(false);
  });
});
