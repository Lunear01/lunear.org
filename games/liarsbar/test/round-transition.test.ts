import { describe, expect, it } from "vitest";
import { applyAction, createGame, startNextRound, type FinishedState, type PlayingState, type RoundEndState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

/** seat 0 plays a lie under table rank Q; seat 1 challenges; seat 0 (the liar) spins with `chamber`. */
function eliminateSeat0(chamber: number): RoundEndState | FinishedState {
  const deck = buildRoundDeck({ 0: ["K1"] });
  const state = createGame({
    shuffledDeck: deck,
    tableRank: "Q",
    bulletPositions: bulletPositions(6, { 0: chamber }),
    firstSeat: 0,
    baseStake: 10,
  });
  const played = applyAction(state, 0, { type: "play", cardIds: ["K1"] });
  if (!played.ok) throw new Error("play rejected");
  const challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
  if (!challenged.ok) throw new Error("challenge rejected");
  return challenged.state as RoundEndState | FinishedState;
}

describe("round end: nextFirstSeat when the loser survives", () => {
  it("the loser (survivor) leads the next round", () => {
    const state = eliminateSeat0(6) as RoundEndState;
    expect(state.phase).toBe("roundEnd");
    expect(state.players[0].alive).toBe(true);
    expect(state.nextFirstSeat).toBe(0);
  });
});

describe("round end: nextFirstSeat when the loser dies", () => {
  it("the next alive seat after the eliminated seat leads the next round", () => {
    const state = eliminateSeat0(1) as RoundEndState;
    expect(state.phase).toBe("roundEnd");
    expect(state.players[0].alive).toBe(false);
    expect(state.nextFirstSeat).toBe(1); // next alive seat after seat 0
  });
});

describe("startNextRound: dealing only to alive seats", () => {
  it("deals fresh 5-card hands only to seats still alive, and an empty hand to the eliminated seat", () => {
    const roundEnd = eliminateSeat0(1) as RoundEndState;
    const deck2 = buildRoundDeck({});
    const playing = startNextRound(roundEnd, { shuffledDeck: deck2, tableRank: "K" });
    expect(playing.phase).toBe("playing");
    expect(playing.hands[0].length).toBe(0);
    expect(playing.hands[1].length).toBe(5);
    expect(playing.hands[2].length).toBe(5);
    expect(playing.hands[3].length).toBe(5);
    expect(playing.currentTurn).toBe(roundEnd.nextFirstSeat);
    expect(playing.tableRank).toBe("K");
    // Player status (alive/pulls/bulletChamber) carries forward unchanged from the roundEnd state.
    expect(playing.players).toEqual(roundEnd.players);
  });

  it("rejects a play from the dead seat: not-your-turn, since it can never hold the turn", () => {
    const roundEnd = eliminateSeat0(1) as RoundEndState;
    const playing = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({}), tableRank: "K" });
    const result = applyAction(playing, 0, { type: "play", cardIds: [] });
    expect(result).toEqual({ ok: false, reason: "not-your-turn" });
  });
});

describe("multi-round elimination sequencing", () => {
  it("skips an already-dead seat when picking the next alive seat after a second elimination", () => {
    // All 4 seats' chambers are fixed once, at game creation: seats 0 and 1 die on their first
    // spin (chamber 1); seats 2 and 3 are safe (chamber 6) throughout this script.
    const positions = { 0: 1, 1: 1, 2: 6, 3: 6 };

    let state = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["K1"] }),
      tableRank: "Q",
      bulletPositions: positions,
      firstSeat: 0,
      baseStake: 10,
    });
    let played = applyAction(state, 0, { type: "play", cardIds: ["K1"] }); // lie
    if (!played.ok) throw new Error("play rejected");
    let challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    let roundEnd = challenged.state as RoundEndState;
    expect(roundEnd.players[0].alive).toBe(false); // seat 0 dies (chamber 1)
    expect(roundEnd.nextFirstSeat).toBe(1);

    const playing2 = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({ 1: ["K1"] }), tableRank: "Q" });
    expect(playing2.hands[0].length).toBe(0); // dead seat dealt nothing
    played = applyAction(playing2, 1, { type: "play", cardIds: ["K1"] }); // lie
    if (!played.ok) throw new Error("play rejected");
    challenged = applyAction(played.state as PlayingState, 2, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    roundEnd = challenged.state as RoundEndState;
    expect(roundEnd.players[1].alive).toBe(false); // seat 1 dies too (chamber 1)

    // nextFirstSeat must skip the already-dead seat 0 and land on seat 2, not wrap onto seat 0.
    expect(roundEnd.nextFirstSeat).toBe(2);
  });
});

describe("win detection: exactly 1 alive seat finishes the game", () => {
  it("phase becomes finished with the correct winner once only one seat remains alive", () => {
    // Seats 0, 1, 2 all die on their first spin (chamber 1); seat 3 is safe (chamber 6) and
    // is never the one who has to spin in this script, so it survives as the sole winner.
    const positions = { 0: 1, 1: 1, 2: 1, 3: 6 };

    let state = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["K1"] }),
      tableRank: "Q",
      bulletPositions: positions,
      firstSeat: 0,
      baseStake: 10,
    });
    let played = applyAction(state, 0, { type: "play", cardIds: ["K1"] });
    if (!played.ok) throw new Error("play rejected");
    let challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    let roundEnd = challenged.state as RoundEndState; // seat 0 dead; alive {1,2,3}
    expect(roundEnd.phase).toBe("roundEnd");

    let playing = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({ 1: ["K1"] }), tableRank: "Q" });
    played = applyAction(playing, 1, { type: "play", cardIds: ["K1"] });
    if (!played.ok) throw new Error("play rejected");
    challenged = applyAction(played.state as PlayingState, 2, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    roundEnd = challenged.state as RoundEndState; // seat 1 dead; alive {2,3}
    expect(roundEnd.players[1].alive).toBe(false);
    expect(roundEnd.phase).toBe("roundEnd"); // 2 still alive

    playing = startNextRound(roundEnd, { shuffledDeck: buildRoundDeck({ 2: ["K1"] }), tableRank: "Q" });
    played = applyAction(playing, 2, { type: "play", cardIds: ["K1"] });
    if (!played.ok) throw new Error("play rejected");
    challenged = applyAction(played.state as PlayingState, 3, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    const finished = challenged.state as FinishedState; // seat 2 dead; only seat 3 remains
    expect(finished.phase).toBe("finished");
    expect(finished.winner).toBe(3);
    expect(finished.players[0].alive).toBe(false);
    expect(finished.players[1].alive).toBe(false);
    expect(finished.players[2].alive).toBe(false);
    expect(finished.players[3].alive).toBe(true);

    // A finished game accepts no further actions.
    expect(applyAction(finished, 3, { type: "challenge" })).toEqual({ ok: false, reason: "wrong-phase" });
  });
});
