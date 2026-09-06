import { describe, expect, it } from "vitest";
import { applyAction, createGame, startNextRound, type PlayingState, type RoundEndState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

/** Seat 0 plays a lie; seat 1 challenges. Seat 0 (the liar) always spins. */
function loserSpinsOnce(chamberForSeat0: number): RoundEndState {
  const deck = buildRoundDeck({ 0: ["K1"] });
  const state = createGame({
    shuffledDeck: deck,
    tableRank: "Q",
    bulletPositions: bulletPositions(6, { 0: chamberForSeat0 }),
    firstSeat: 0,
    baseStake: 10,
  });
  const played = applyAction(state, 0, { type: "play", cardIds: ["K1"] });
  if (!played.ok) throw new Error("play rejected");
  const playing = played.state as PlayingState;
  const challenged = applyAction(playing, playing.currentTurn, { type: "challenge" });
  if (!challenged.ok) throw new Error("challenge rejected");
  return challenged.state as RoundEndState;
}

describe("roulette: death exactly at the predetermined chamber", () => {
  it("dies when pulls (after incrementing) equals the bullet chamber", () => {
    const state = loserSpinsOnce(1);
    expect(state.players[0].pulls).toBe(1);
    expect(state.players[0].alive).toBe(false);
  });

  it("survives when pulls does not yet equal the bullet chamber", () => {
    const state = loserSpinsOnce(6);
    expect(state.players[0].pulls).toBe(1);
    expect(state.players[0].alive).toBe(true);
  });

  it("every seat's chamber is fixed 1-6 and can differ per seat", () => {
    const deck = buildRoundDeck({});
    const state = createGame({
      shuffledDeck: deck,
      tableRank: "Q",
      bulletPositions: { 0: 1, 1: 2, 2: 3, 3: 4 },
      firstSeat: 0,
      baseStake: 10,
    });
    expect(state.players[0].bulletChamber).toBe(1);
    expect(state.players[1].bulletChamber).toBe(2);
    expect(state.players[2].bulletChamber).toBe(3);
    expect(state.players[3].bulletChamber).toBe(4);
  });

  it("rejects an out-of-range or non-integer bullet position at game creation", () => {
    const deck = buildRoundDeck({});
    expect(() =>
      createGame({ shuffledDeck: deck, tableRank: "Q", bulletPositions: bulletPositions(0), firstSeat: 0, baseStake: 10 }),
    ).toThrow(/1-6/);
    expect(() =>
      createGame({ shuffledDeck: deck, tableRank: "Q", bulletPositions: bulletPositions(7), firstSeat: 0, baseStake: 10 }),
    ).toThrow(/1-6/);
    expect(() =>
      createGame({
        shuffledDeck: deck,
        tableRank: "Q",
        bulletPositions: bulletPositions(3.5),
        firstSeat: 0,
        baseStake: 10,
      }),
    ).toThrow(/1-6/);
  });
});

describe("roulette: pull counter persists across rounds; bullet chamber never resets", () => {
  it("a survivor's pulls keep accumulating toward the same fixed chamber in later rounds", () => {
    // Seat 0's chamber is 3: it must survive two spins (pulls 1, 2) and die on the third.
    let roundEnd = loserSpinsOnce(3);
    expect(roundEnd.players[0].pulls).toBe(1);
    expect(roundEnd.players[0].alive).toBe(true);
    expect(roundEnd.players[0].bulletChamber).toBe(3);
    expect(roundEnd.nextFirstSeat).toBe(0); // survived -> leads next round

    // Round 2: seat 0 leads again and lies again; seat 1 challenges again.
    const deck2 = buildRoundDeck({ 0: ["A1"] }); // table rank will be K this round -> a lie
    let playing = startNextRound(roundEnd, { shuffledDeck: deck2, tableRank: "K" });
    expect(playing.players[0].bulletChamber).toBe(3); // unchanged from game creation
    expect(playing.players[0].pulls).toBe(1); // carried forward, not reset
    let played = applyAction(playing, 0, { type: "play", cardIds: ["A1"] });
    if (!played.ok) throw new Error("play rejected");
    let challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    roundEnd = challenged.state as RoundEndState;
    expect(roundEnd.players[0].pulls).toBe(2);
    expect(roundEnd.players[0].alive).toBe(true); // pulls=2 != chamber 3

    // Round 3: same seat, same chamber, third spin -> dies exactly on pull 3.
    const deck3 = buildRoundDeck({ 0: ["K1"] }); // table rank Q this round -> a lie
    playing = startNextRound(roundEnd, { shuffledDeck: deck3, tableRank: "Q" });
    played = applyAction(playing, 0, { type: "play", cardIds: ["K1"] });
    if (!played.ok) throw new Error("play rejected");
    challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    const finalState = challenged.state as RoundEndState; // seat 0 dies, but seats 1/2/3 remain alive
    expect(finalState.phase).toBe("roundEnd");
    expect(finalState.lastReveal.loserSeat).toBe(0);
    expect(finalState.players[0].pulls).toBe(3);
    expect(finalState.players[0].alive).toBe(false); // pulls == chamber 3 -> dies
  });
});
