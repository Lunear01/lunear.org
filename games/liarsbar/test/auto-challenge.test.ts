import { describe, expect, it } from "vitest";
import { applyAction, createGame, type PlayingState, type RoundEndState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

function play(state: PlayingState, seat: 0 | 1 | 2 | 3, cardIds: string[]): PlayingState | RoundEndState {
  const result = applyAction(state, seat, { type: "play", cardIds });
  if (!result.ok) throw new Error(`play rejected: ${result.reason} (seat ${seat})`);
  return result.state as PlayingState | RoundEndState;
}

function asPlaying(state: PlayingState | RoundEndState): PlayingState {
  if (state.phase !== "playing") throw new Error(`expected still playing, got ${state.phase}`);
  return state;
}

describe("mid-round skip: an alive player with no cards is passed over without acting", () => {
  it("advances turn straight from seat 1 to seat 2 once seat 1 has no cards, without emptying anyone else", () => {
    const deck = buildRoundDeck({ 1: ["Q1", "Q2", "Q3", "Q4", "Q5"] });
    const game = createGame({
      shuffledDeck: deck,
      tableRank: "Q",
      bulletPositions: bulletPositions(6),
      firstSeat: 1,
      baseStake: 10,
    });

    let state = asPlaying(play(game, 1, ["Q1", "Q2", "Q3"])); // 2 left; seats 0,2,3 still hold 5 each
    expect(state.currentTurn).toBe(2);

    state = asPlaying(play(state, 2, [state.hands[2][0].id]));
    state = asPlaying(play(state, 3, [state.hands[3][0].id]));
    expect(state.currentTurn).toBe(0);
    state = asPlaying(play(state, 0, [state.hands[0][0].id]));
    expect(state.currentTurn).toBe(1);

    // Seat 1 empties its last 2 cards. Seats 0, 2, 3 all still hold cards, so this is an
    // ordinary play, not an auto-challenge — turn simply skips the now-empty seat 1.
    state = asPlaying(play(state, 1, ["Q4", "Q5"]));
    expect(state.hands[1].length).toBe(0);
    expect(state.currentTurn).toBe(2);
  });
});

describe("forced auto-challenge: the last play is auto-challenged once every other alive seat has no cards", () => {
  it("triggers immediately after the play that leaves all other alive seats empty-handed", () => {
    // Seat 0's 5 cards, spent across two earlier singles (unchallenged, later superseded) and a
    // final lying triple (K,K,K) under table rank Q — that final triple is the one at risk.
    const deck = buildRoundDeck({ 0: ["Q1", "Q2", "K1", "K2", "K3"] });
    const game = createGame({
      shuffledDeck: deck,
      tableRank: "Q",
      bulletPositions: bulletPositions(6, { 0: 3 }), // seat 0 survives this spin (1st pull != chamber 3)
      firstSeat: 0,
      baseStake: 10,
    });

    let state = asPlaying(play(game, 0, ["Q1"])); // 4 left; turn -> 1
    expect(state.currentTurn).toBe(1);
    state = asPlaying(play(state, 1, state.hands[1].slice(0, 3).map((c) => c.id))); // seat 1: 2 left
    state = asPlaying(play(state, 2, state.hands[2].slice(0, 3).map((c) => c.id))); // seat 2: 2 left
    state = asPlaying(play(state, 3, state.hands[3].slice(0, 3).map((c) => c.id))); // seat 3: 2 left
    expect(state.currentTurn).toBe(0);

    state = asPlaying(play(state, 0, ["Q2"])); // 3 left; every other seat still holds 2 -> normal advance
    expect(state.currentTurn).toBe(1);
    state = asPlaying(play(state, 1, state.hands[1].map((c) => c.id))); // seat 1 empties (0 left)
    expect(state.currentTurn).toBe(2); // seat 0 still has 3 cards, so no trigger yet
    state = asPlaying(play(state, 2, state.hands[2].map((c) => c.id))); // seat 2 empties (0 left)
    expect(state.currentTurn).toBe(3); // seat 0 still has cards -> normal advance, not seat 0 yet
    state = asPlaying(play(state, 3, state.hands[3].map((c) => c.id))); // seat 3 empties (0 left)
    // Now seats 1, 2, 3 are all alive with 0 cards; only seat 0 (with 3 cards) can still act.
    expect(state.currentTurn).toBe(0);

    // Seat 0's final play empties its own hand too, but that's irrelevant to the trigger: the
    // check is about every OTHER alive seat, which are already all empty before this play happens.
    const result = applyAction(state, 0, { type: "play", cardIds: ["K1", "K2", "K3"] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state.phase).toBe("roundEnd");
    const roundEnd = result.state as RoundEndState;

    expect(roundEnd.lastReveal.auto).toBe(true);
    expect(roundEnd.lastReveal.playSeat).toBe(0);
    expect(roundEnd.lastReveal.challengerSeat).toBe(1); // next alive seat after seat 0, in rotation
    expect(roundEnd.lastReveal.cards.map((c) => c.id).sort()).toEqual(["K1", "K2", "K3"]);
    expect(roundEnd.lastReveal.wasTruthful).toBe(false); // K != table rank Q, and none are jokers
    expect(roundEnd.lastReveal.loserSeat).toBe(0); // the liar spins, not the (involuntary) auto-challenger
    expect(roundEnd.players[0].pulls).toBe(1);
    expect(roundEnd.players[0].alive).toBe(true); // chamber 3, this was pull #1 -> survives
    expect(roundEnd.nextFirstSeat).toBe(0); // the loser survived, so they lead the next round
    // The auto-challenger (seat 1) never actually spins here, since the play was a lie, not truthful.
    expect(roundEnd.players[1].pulls).toBe(0);
  });

  it("assigns the challenger role to the auto-challenger, who spins if the auto-challenged play turns out truthful", () => {
    const deck = buildRoundDeck({ 0: ["Q1", "Q2", "Q3", "Q4", "Q5"] }); // every card is the table rank -> truthful
    const game = createGame({
      shuffledDeck: deck,
      tableRank: "Q",
      bulletPositions: bulletPositions(6, { 1: 1 }), // seat 1 (the forced auto-challenger) dies if it spins
      firstSeat: 0,
      baseStake: 10,
    });

    // Each of seats 1/2/3 needs two plays (max 3 cards per play) to empty a 5-card hand, so turn
    // must cycle back to each of them once before they're fully out — seat 0 plays a filler single
    // in between each lap around the table, keeping some cards in reserve for its final play.
    let state = asPlaying(play(game, 0, ["Q1"])); // seat 0: 4 left
    state = asPlaying(play(state, 1, state.hands[1].slice(0, 3).map((c) => c.id))); // seat 1: 2 left
    state = asPlaying(play(state, 2, state.hands[2].slice(0, 3).map((c) => c.id))); // seat 2: 2 left
    state = asPlaying(play(state, 3, state.hands[3].slice(0, 3).map((c) => c.id))); // seat 3: 2 left

    state = asPlaying(play(state, 0, ["Q2"])); // seat 0: 3 left
    state = asPlaying(play(state, 1, state.hands[1].map((c) => c.id))); // seat 1 empties (0 left)
    expect(state.currentTurn).toBe(2); // seat 0 still holds cards -> no trigger yet
    state = asPlaying(play(state, 2, state.hands[2].map((c) => c.id))); // seat 2 empties (0 left)
    expect(state.currentTurn).toBe(3); // seat 0 still holds cards -> no trigger yet
    state = asPlaying(play(state, 3, state.hands[3].map((c) => c.id))); // seat 3 empties (0 left)
    expect(state.currentTurn).toBe(0); // seat 0 is the only one left holding cards

    const result = applyAction(state, 0, { type: "play", cardIds: ["Q3", "Q4"] }); // truthful again
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const roundEnd = result.state as RoundEndState;

    expect(roundEnd.lastReveal.auto).toBe(true);
    expect(roundEnd.lastReveal.challengerSeat).toBe(1);
    expect(roundEnd.lastReveal.wasTruthful).toBe(true);
    expect(roundEnd.lastReveal.loserSeat).toBe(1); // wrongly-forced "liar!" call costs the auto-challenger
    expect(roundEnd.players[1].pulls).toBe(1);
    expect(roundEnd.players[1].alive).toBe(false); // chamber 1, first pull -> dies
    expect(roundEnd.nextFirstSeat).toBe(2); // seat 1 died -> next alive seat after seat 1
  });
});
