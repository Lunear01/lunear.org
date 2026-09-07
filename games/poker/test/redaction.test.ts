import { describe, expect, it } from "vitest";
import { createGame, viewFor, type GameState, type RedactedFinishedView, type RedactedShowdownView } from "../src/game";
import type { Card } from "../src/cards";
import { act, buildDeck } from "./helpers";

function idsOf(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id);
}

describe("viewFor (betting phases): redaction", () => {
  const seats = [0, 1, 2];

  function newGame(): GameState {
    const deck = buildDeck(seats, { hole: { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"], 2: ["Qh", "Qd"] } });
    return createGame({ seats, dealerSeat: 0, stake: 10, shuffledDeck: deck });
  }

  it("shows the viewer's own hole cards", () => {
    const state = newGame();
    const view = viewFor(state, 0);
    if (view.phase === "showdown" || view.phase === "finished") throw new Error("unreachable");
    expect(idsOf(view.holeCards).sort()).toEqual(["Ad", "Ah"]);
  });

  it("never includes any opponent's hole card id, for any viewer", () => {
    const state = newGame();
    for (const viewer of seats) {
      const view = viewFor(state, viewer);
      const json = JSON.stringify(view);
      for (const seat of seats) {
        if (seat === viewer) continue;
        for (const card of (state as { players: Record<number, { holeCards: readonly Card[] }> }).players[seat].holeCards) {
          expect(json).not.toContain(`"${card.id}"`);
        }
      }
    }
  });

  it("exposes opponents only as a public status (folded/allIn/committed/streetCommitted/holeCardCount), never their cards", () => {
    const state = newGame();
    const view = viewFor(state, 0);
    if (view.phase === "showdown" || view.phase === "finished") throw new Error("unreachable");
    for (const seat of seats) {
      expect(Object.keys(view.players[seat]).sort()).toEqual([
        "allIn",
        "committed",
        "folded",
        "holeCardCount",
        "streetCommitted",
      ]);
      expect(view.players[seat].holeCardCount).toBe(2);
    }
  });

  it("shared public numbers (pot, currentBet, currentTurn, community) are identical across viewers", () => {
    const state = newGame();
    const a = viewFor(state, 0);
    const b = viewFor(state, 1);
    if (a.phase === "showdown" || a.phase === "finished" || b.phase === "showdown" || b.phase === "finished") {
      throw new Error("unreachable");
    }
    expect(a.pot).toBe(b.pot);
    expect(a.currentBet).toBe(b.currentBet);
    expect(a.currentTurn).toBe(b.currentTurn);
    expect(a.community).toEqual(b.community);
  });
});

describe("viewFor (showdown phase): reveals only non-folded hands", () => {
  it("reveals hole cards + a {category, ranks} classification for every non-folded seat, to every viewer", () => {
    const seats = [0, 1];
    const community = ["2c", "5d", "9s", "Jc", "3h"];
    const deck = buildDeck(seats, { hole: { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"] }, community });
    let state: GameState = createGame({ seats, dealerSeat: 0, stake: 10, shuffledDeck: deck });
    state = act(state, 0, { type: "raise", toAmount: 1000 });
    state = act(state, 1, { type: "call" });
    expect(state.phase).toBe("showdown");

    for (const viewer of seats) {
      const view = viewFor(state, viewer) as RedactedShowdownView;
      expect(view.phase).toBe("showdown");
      const revealBySeat = new Map(view.reveals.map((r) => [r.seat, r]));
      expect(idsOf(revealBySeat.get(0)!.holeCards).sort()).toEqual(["Ad", "Ah"]);
      expect(idsOf(revealBySeat.get(1)!.holeCards).sort()).toEqual(["Kd", "Kh"]);
      expect(revealBySeat.get(0)!.hand.category).toBe("pair");
      expect(Object.keys(revealBySeat.get(0)!.hand).sort()).toEqual(["category", "ranks"]);
    }
  });

  it("a folded seat's hand is never revealed, even at showdown", () => {
    const seats = [0, 1, 2];
    const deck = buildDeck(seats, { hole: { 0: ["2c", "3d"], 1: ["Ah", "Ad"], 2: ["Kh", "Kd"] } });
    let state: GameState = createGame({ seats, dealerSeat: 0, stake: 10, shuffledDeck: deck });

    // Preflop: UTG (== dealer, 3-handed) folds; SB calls; BB checks the option.
    state = act(state, 0, { type: "fold" });
    state = act(state, 1, { type: "call" });
    state = act(state, 2, { type: "check" });
    expect(state.phase).toBe("flop");
    for (let street = 0; street < 3; street++) {
      state = act(state, 1, { type: "check" });
      state = act(state, 2, { type: "check" });
    }
    expect(state.phase).toBe("showdown");

    const view = viewFor(state, 0) as RedactedShowdownView;
    expect(view.reveals.map((r) => r.seat).sort()).toEqual([1, 2]); // seat 0 folded, never revealed
    expect(view.players[0]).toEqual({ folded: true, committed: 0 });
    const json = JSON.stringify(view);
    expect(json).not.toContain("2c");
    expect(json).not.toContain("3d");
  });
});

describe("viewFor (finished phase): no reveal on an uncontested fold-out win", () => {
  it("never includes any hole card id, for any viewer, including the winner's own view", () => {
    const seats = [0, 1, 2];
    const deck = buildDeck(seats, { hole: { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"], 2: ["Qh", "Qd"] } });
    let state: GameState = createGame({ seats, dealerSeat: 0, stake: 10, shuffledDeck: deck });
    state = act(state, 0, { type: "fold" });
    state = act(state, 1, { type: "fold" });
    expect(state.phase).toBe("finished");

    for (const viewer of seats) {
      const view = viewFor(state, viewer) as RedactedFinishedView;
      expect(view.phase).toBe("finished");
      expect(view.winner).toBe(2);
      const json = JSON.stringify(view);
      for (const id of ["Ah", "Ad", "Kh", "Kd", "Qh", "Qd"]) expect(json).not.toContain(id);
    }
  });
});

describe("8-seat game: redaction still holds", () => {
  it("no opponent hole cards leak, for any of the 8 viewers", () => {
    const seats = [0, 1, 2, 3, 4, 5, 6, 7];
    const deck = buildDeck(seats, {});
    const state = createGame({ seats, dealerSeat: 3, stake: 10, shuffledDeck: deck });
    for (const viewer of seats) {
      const view = viewFor(state, viewer);
      if (view.phase === "showdown" || view.phase === "finished") throw new Error("unreachable");
      const json = JSON.stringify(view);
      for (const seat of seats) {
        if (seat === viewer) continue;
        for (const card of state.players[seat].holeCards) expect(json).not.toContain(`"${card.id}"`);
      }
    }
  });
});
