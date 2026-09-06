import { describe, expect, it } from "vitest";
import { applyAction, createGame, viewFor, type FinishedState, type PlayingState, type RoundEndState } from "../src/game";
import { buildRoundDeck, bulletPositions } from "./helpers";

function newGame(): PlayingState {
  const deck = buildRoundDeck({ 0: ["Q1", "Q2", "K1"] });
  return createGame({
    shuffledDeck: deck,
    tableRank: "Q",
    bulletPositions: { 0: 1, 1: 2, 2: 3, 3: 4 },
    firstSeat: 0,
    baseStake: 10,
  });
}

/** The "bulletChamber" key must never appear anywhere in the JSON-serialized view. Each call
 * site pairs this with an explicit Object.keys check per seat, covering the value side too. */
function assertNoBulletChamberLeak(view: unknown): void {
  expect(JSON.stringify(view)).not.toMatch(/bulletChamber/i);
}

describe("viewFor (playing phase): redaction", () => {
  it("shows the viewer's own hand in full", () => {
    const state = newGame();
    const view = viewFor(state, 0);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.hand.map((c) => c.id).sort()).toEqual(state.hands[0].map((c) => c.id).sort());
  });

  it("shows opponents' hands as counts only, never card identities", () => {
    const state = newGame();
    const view = viewFor(state, 0);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.handCounts).toEqual({ 0: 5, 1: 5, 2: 5, 3: 5 });
    expect(JSON.stringify(view)).not.toContain(state.hands[1][0].id);
  });

  it("hides the identity of a pending face-down play, exposing only seat + count", () => {
    let state = newGame();
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1", "Q2"] });
    if (!played.ok) throw new Error("play rejected");
    state = played.state as PlayingState;

    const opponentView = viewFor(state, 1);
    if (opponentView.phase !== "playing") throw new Error("unreachable");
    expect(opponentView.lastPlay).toEqual({ seat: 0, cardCount: 2 });
    expect(JSON.stringify(opponentView)).not.toContain("Q1");
    expect(JSON.stringify(opponentView)).not.toContain("Q2");

    // Even the player who made the play sees only the public count-shaped lastPlay in their view
    // (their own hand still shows the cards they still hold, just not the ones already face down).
    const ownView = viewFor(state, 0);
    if (ownView.phase !== "playing") throw new Error("unreachable");
    expect(ownView.lastPlay).toEqual({ seat: 0, cardCount: 2 });
  });

  it("reports play history as seat + count only, never card identities", () => {
    let state = newGame();
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1", "Q2"] });
    if (!played.ok) throw new Error("play rejected");
    state = played.state as PlayingState;
    const view = viewFor(state, 2);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.history).toEqual([{ seat: 0, cardCount: 2 }]);
  });

  it("exposes table rank, current turn, alive status, and pull counters publicly", () => {
    const state = newGame();
    const view = viewFor(state, 3);
    if (view.phase !== "playing") throw new Error("unreachable");
    expect(view.tableRank).toBe("Q");
    expect(view.currentTurn).toBe(0);
    expect(view.players).toEqual({
      0: { alive: true, pulls: 0 },
      1: { alive: true, pulls: 0 },
      2: { alive: true, pulls: 0 },
      3: { alive: true, pulls: 0 },
    });
  });

  it("never includes any bullet chamber, for any viewer", () => {
    const state = newGame();
    for (const viewer of [0, 1, 2, 3] as const) {
      const view = viewFor(state, viewer);
      assertNoBulletChamberLeak(view);
      if (view.phase !== "playing") throw new Error("unreachable");
      for (const seat of [0, 1, 2, 3] as const) {
        expect(Object.keys(view.players[seat]).sort()).toEqual(["alive", "pulls"]);
      }
    }
  });
});

describe("viewFor (roundEnd phase): the resolved reveal is public to everyone", () => {
  it("shows the actual revealed cards once a challenge has resolved", () => {
    let state = newGame();
    const played = applyAction(state, 0, { type: "play", cardIds: ["Q1"] });
    if (!played.ok) throw new Error("play rejected");
    const challenged = applyAction(played.state as PlayingState, 1, { type: "challenge" });
    if (!challenged.ok) throw new Error("challenge rejected");
    const roundEnd = challenged.state as RoundEndState;

    for (const viewer of [0, 1, 2, 3] as const) {
      const view = viewFor(roundEnd, viewer);
      if (view.phase !== "roundEnd") throw new Error("unreachable");
      expect(view.lastReveal.cards.map((c) => c.id)).toEqual(["Q1"]);
      expect(view.lastReveal.wasTruthful).toBe(true);
      assertNoBulletChamberLeak(view);
      for (const seat of [0, 1, 2, 3] as const) {
        expect(Object.keys(view.players[seat]).sort()).toEqual(["alive", "pulls"]);
      }
    }
  });
});

describe("viewFor (finished phase): redaction still holds at game end", () => {
  it("never leaks bullet chambers even once the game is over", () => {
    const finished: FinishedState = {
      phase: "finished",
      baseStake: 10,
      winner: 3,
      players: {
        0: { alive: false, pulls: 2, bulletChamber: 2 },
        1: { alive: false, pulls: 1, bulletChamber: 1 },
        2: { alive: false, pulls: 4, bulletChamber: 4 },
        3: { alive: true, pulls: 0, bulletChamber: 6 },
      },
      lastReveal: {
        playSeat: 2,
        challengerSeat: 3,
        cards: [],
        wasTruthful: false,
        loserSeat: 2,
        auto: false,
      },
    };
    for (const viewer of [0, 1, 2, 3] as const) {
      const view = viewFor(finished, viewer);
      assertNoBulletChamberLeak(view);
      if (view.phase !== "finished") throw new Error("unreachable");
      expect(view.winner).toBe(3);
      for (const seat of [0, 1, 2, 3] as const) {
        expect(Object.keys(view.players[seat]).sort()).toEqual(["alive", "pulls"]);
      }
    }
  });
});
