import { describe, expect, it } from "vitest";
import { applyAction, createGame, settle, viewFor, type FinishedState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

// createGame's activeSeats option: a 2-4 player game where absent seats are
// never dealt in, never take turns, and settle at 0. Omitting the option (the
// pre-existing 4-player shape) is covered by every other test file.

describe("createGame with activeSeats", () => {
  it("marks absent seats not-alive and deals them nothing", () => {
    const state = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["Q1"], 2: ["Q6"] }),
      tableRank: "Q",
      bulletPositions: bulletPositions(6),
      firstSeat: 0,
      activeSeats: [0, 2],
      baseStake: 10,
    });
    expect(state.activeSeats).toEqual([0, 2]);
    expect(state.players[0].alive).toBe(true);
    expect(state.players[1].alive).toBe(false);
    expect(state.players[2].alive).toBe(true);
    expect(state.players[3].alive).toBe(false);
    expect(state.hands[1]).toEqual([]);
    expect(state.hands[3]).toEqual([]);
    expect(state.hands[0]).toHaveLength(5);
    expect(state.hands[2]).toHaveLength(5);
  });

  it("rejects fewer than 2 active seats, duplicates, and an inactive firstSeat", () => {
    const base = {
      shuffledDeck: buildRoundDeck({}),
      tableRank: "Q" as const,
      bulletPositions: bulletPositions(6),
      firstSeat: 0 as const,
      baseStake: 10,
    };
    expect(() => createGame({ ...base, activeSeats: [0] })).toThrow(/at least 2/);
    expect(() => createGame({ ...base, activeSeats: [0, 0, 2] })).toThrow(/distinct/);
    expect(() => createGame({ ...base, activeSeats: [1, 2] })).toThrow(/firstSeat/);
  });

  it("turn order skips absent seats", () => {
    const state = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["Q1"], 3: ["Q6"] }),
      tableRank: "Q",
      bulletPositions: bulletPositions(6),
      firstSeat: 0,
      activeSeats: [0, 3],
      baseStake: 10,
    });
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1"] });
    if (!played.ok || played.state.phase !== "playing") throw new Error("expected playing state");
    expect(played.state.currentTurn).toBe(3);
  });

  it("a lost challenge in a 2-player game finishes it (one alive seat left)", () => {
    const state = createGame({
      shuffledDeck: buildRoundDeck({ 0: ["Q1"], 1: ["K1"] }),
      tableRank: "Q",
      bulletPositions: bulletPositions(1),
      firstSeat: 0,
      activeSeats: [0, 1],
      baseStake: 10,
    });
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1"] });
    if (!played.ok) throw new Error("play rejected");
    const challenged = applyAction(played.state, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    // Truthful play: challenger (seat 1) spins, bullet at 1 kills them.
    expect(challenged.state.phase).toBe("finished");
    if (challenged.state.phase !== "finished") throw new Error("unreachable");
    expect(challenged.state.winner).toBe(0);
    expect(challenged.state.activeSeats).toEqual([0, 1]);
  });
});

describe("settle with activeSeats", () => {
  function finishedTwoPlayer(): FinishedState {
    return {
      phase: "finished",
      activeSeats: [0, 2],
      baseStake: 100,
      winner: 0,
      players: {
        0: { alive: true, pulls: 0, bulletChamber: 6 },
        1: { alive: false, pulls: 0, bulletChamber: 6 },
        2: { alive: false, pulls: 1, bulletChamber: 1 },
        3: { alive: false, pulls: 0, bulletChamber: 6 },
      },
      lastReveal: {
        playSeat: 0,
        challengerSeat: 2,
        cards: [],
        wasTruthful: true,
        loserSeat: 2,
        auto: false,
      },
    };
  }

  it("pays the winner per eliminated active seat; absent seats settle at 0", () => {
    const deltas = settle(finishedTwoPlayer());
    expect(deltas).toEqual({ 0: 100, 1: 0, 2: -100, 3: 0 });
  });

  it("viewFor exposes activeSeats, defaulting to all four when the state predates the field", () => {
    const view = viewFor(finishedTwoPlayer(), 0);
    expect(view.activeSeats).toEqual([0, 2]);
    const legacy = { ...finishedTwoPlayer(), activeSeats: undefined };
    expect(viewFor(legacy, 0).activeSeats).toEqual([0, 1, 2, 3]);
  });
});
