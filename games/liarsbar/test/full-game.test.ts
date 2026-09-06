import { describe, expect, it } from "vitest";
import {
  applyAction,
  createGame,
  settle,
  startNextRound,
  type Action,
  type FinishedState,
  type GameState,
  type PlayingState,
  type RoundEndState,
} from "../src/game";
import type { Seat } from "../src/deal";
import { buildRoundDeck } from "./helpers";

/** Apply an action, throwing with the rejection reason if it's unexpectedly refused. */
function act(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    throw new Error(`applyAction rejected: ${result.reason} (seat ${seat}, ${JSON.stringify(action)})`);
  }
  return result.state;
}

describe("full scripted game: 4 players, 3 rounds, creation to settlement", () => {
  it("eliminates seats 1, 2, and 0 in turn and produces exact zero-sum deltas for the winner (seat 3)", () => {
    // Seats 0, 1, 2 each die on their very first spin (chamber 1); seat 3 (chamber 6) is safe
    // and never has to spin in this script, so it ends up the sole survivor.
    const bulletPositions = { 0: 1, 1: 1, 2: 1, 3: 6 };

    // --- Round 1: seat 0 leads, table rank Q. Seat 0 plays truthfully; seat 1 wrongly calls
    // "liar!" and pays for it. ---------------------------------------------------------------
    let state: GameState = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["Q1", "Q2"] }),
      tableRank: "Q",
      bulletPositions,
      firstSeat: 0,
      baseStake: 100,
    });
    state = act(state, 0, { type: "play", cardIds: ["Q1", "Q2"] }); // truthful
    expect((state as PlayingState).currentTurn).toBe(1);
    state = act(state, 1, { type: "challenge" });

    expect(state.phase).toBe("roundEnd");
    let roundEnd = state as RoundEndState;
    expect(roundEnd.lastReveal).toEqual({
      playSeat: 0,
      challengerSeat: 1,
      cards: expect.arrayContaining([expect.objectContaining({ id: "Q1" }), expect.objectContaining({ id: "Q2" })]),
      wasTruthful: true,
      loserSeat: 1,
      auto: false,
    });
    expect(roundEnd.players[1].alive).toBe(false);
    expect(roundEnd.players[1].pulls).toBe(1);
    expect(roundEnd.nextFirstSeat).toBe(2); // seat 1 died -> next alive seat after it

    // --- Round 2: seat 2 leads, table rank K. Seat 2 bluffs; seat 3 correctly calls "liar!". ---
    state = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({ 2: ["Q3"] }), tableRank: "K" });
    expect((state as PlayingState).hands[1].length).toBe(0); // dead seat dealt nothing
    state = act(state, 2, { type: "play", cardIds: ["Q3"] }); // a lie: Q3 is not table rank K
    expect((state as PlayingState).currentTurn).toBe(3);
    state = act(state, 3, { type: "challenge" });

    expect(state.phase).toBe("roundEnd");
    roundEnd = state as RoundEndState;
    expect(roundEnd.lastReveal.wasTruthful).toBe(false);
    expect(roundEnd.lastReveal.loserSeat).toBe(2); // the liar, not the correct challenger
    expect(roundEnd.players[2].alive).toBe(false);
    expect(roundEnd.nextFirstSeat).toBe(3); // seat 2 died -> next alive seat after it

    // --- Round 3: seat 3 leads, table rank A. Seat 3 plays truthfully; seat 0 wrongly calls
    // "liar!" and, on chamber 1, dies — leaving seat 3 the sole survivor. ----------------------
    state = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({ 3: ["A1"] }), tableRank: "A" });
    expect((state as PlayingState).hands[1].length).toBe(0);
    expect((state as PlayingState).hands[2].length).toBe(0);
    state = act(state, 3, { type: "play", cardIds: ["A1"] }); // truthful
    expect((state as PlayingState).currentTurn).toBe(0);
    state = act(state, 0, { type: "challenge" });

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.winner).toBe(3);
    expect(finished.lastReveal.wasTruthful).toBe(true);
    expect(finished.lastReveal.loserSeat).toBe(0);
    expect(finished.players).toEqual({
      0: { alive: false, pulls: 1, bulletChamber: 1 },
      1: { alive: false, pulls: 1, bulletChamber: 1 },
      2: { alive: false, pulls: 1, bulletChamber: 1 },
      3: { alive: true, pulls: 0, bulletChamber: 6 },
    });

    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: -100, 1: -100, 2: -100, 3: 300 });
    expect(deltas[0] + deltas[1] + deltas[2] + deltas[3]).toBe(0);

    // A finished game accepts no further actions.
    expect(applyAction(finished, 3, { type: "challenge" })).toEqual({ ok: false, reason: "wrong-phase" });
  });
});
