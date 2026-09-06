import { describe, expect, it } from "vitest";
import { createDeck } from "../src/cards";
import { applyAction, createGame, viewFor, type FinishedState, type GameState, type PlayingState } from "../src/game";
import { buildDealOrder } from "./helpers";

/**
 * The 3 bottom cards ("landlord cards") are private during bidding but become
 * public to every seat once play starts, per standard Dou Dizhu rules — even
 * though the landlord alone holds them in hand.
 */
function buildPlayingStateWithKnownBottom(): { state: PlayingState; landlordCardIds: string[] } {
  const allIds = createDeck().map((c) => c.id);
  const landlordCardIds = allIds.slice(0, 3);
  const rest = allIds.slice(3);
  const deck = buildDealOrder({
    seat0: rest.slice(0, 17),
    seat1: rest.slice(17, 34),
    seat2: rest.slice(34, 51),
    landlordCards: landlordCardIds,
  });

  const bidding = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: 100 });
  const result = applyAction(bidding, 0, { type: "bid", amount: 3 }); // seat 0 becomes landlord
  if (!result.ok || result.state.phase !== "playing") throw new Error("test setup failed");
  return { state: result.state, landlordCardIds };
}

describe("landlordCards: public once play starts", () => {
  it("a farmer's viewFor during play contains exactly the 3 bottom cards", () => {
    const { state, landlordCardIds } = buildPlayingStateWithKnownBottom();

    const farmerView = viewFor(state, 1); // seat 1 is a farmer, not the landlord
    if (farmerView.phase !== "playing") throw new Error("unreachable");

    expect(farmerView.landlordCards.map((c) => c.id).sort()).toEqual([...landlordCardIds].sort());
    expect(farmerView.landlordCards.length).toBe(3);
  });

  it("the other farmer's viewFor sees the same 3 bottom cards", () => {
    const { state, landlordCardIds } = buildPlayingStateWithKnownBottom();

    const farmerView = viewFor(state, 2);
    if (farmerView.phase !== "playing") throw new Error("unreachable");

    expect(farmerView.landlordCards.map((c) => c.id).sort()).toEqual([...landlordCardIds].sort());
  });

  it("the landlord's own viewFor also reports the bottom cards, which remain part of their hand", () => {
    const { state, landlordCardIds } = buildPlayingStateWithKnownBottom();

    const landlordView = viewFor(state, 0);
    if (landlordView.phase !== "playing") throw new Error("unreachable");

    expect(landlordView.landlordCards.map((c) => c.id).sort()).toEqual([...landlordCardIds].sort());
    const handIds = new Set(landlordView.hand.map((c) => c.id));
    for (const id of landlordCardIds) {
      expect(handIds.has(id)).toBe(true);
    }
    expect(landlordView.hand.length).toBe(20); // 17 dealt + 3 bottom cards
  });

  it("PlayingState itself carries landlordCards through from bidding", () => {
    const { state, landlordCardIds } = buildPlayingStateWithKnownBottom();
    expect(state.landlordCards.map((c) => c.id).sort()).toEqual([...landlordCardIds].sort());
  });

  it("FinishedState and its redacted view retain landlordCards once the hand ends", () => {
    // Landlord ends up holding every card of ranks 3-7 (all 4 suits): four
    // straights, one per suit, enough to clear the whole hand unopposed.
    const landlordAll20 = [
      "3S", "3H", "3D", "3C",
      "4S", "4H", "4D", "4C",
      "5S", "5H", "5D", "5C",
      "6S", "6H", "6D", "6C",
      "7S", "7H", "7D", "7C",
    ];
    const bottomIds = landlordAll20.slice(17, 20);
    const filler = createDeck()
      .map((c) => c.id)
      .filter((id) => !landlordAll20.includes(id));
    const deck = buildDealOrder({
      seat0: landlordAll20.slice(0, 17),
      seat1: filler.slice(0, 17),
      seat2: filler.slice(17, 34),
      landlordCards: bottomIds,
    });

    let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: 100 });
    const bidResult = applyAction(state, 0, { type: "bid", amount: 3 });
    if (!bidResult.ok) throw new Error("bid rejected");
    state = bidResult.state;

    for (const straight of [
      ["3S", "4S", "5S", "6S", "7S"],
      ["3H", "4H", "5H", "6H", "7H"],
      ["3D", "4D", "5D", "6D", "7D"],
      ["3C", "4C", "5C", "6C", "7C"],
    ]) {
      const playResult = applyAction(state, 0, { type: "play", cardIds: straight });
      if (!playResult.ok) throw new Error("play rejected");
      state = playResult.state;
      if (state.phase === "finished") break;
      const pass1 = applyAction(state, 1, { type: "pass" });
      if (!pass1.ok) throw new Error("pass rejected");
      state = pass1.state;
      const pass2 = applyAction(state, 2, { type: "pass" });
      if (!pass2.ok) throw new Error("pass rejected");
      state = pass2.state;
    }

    expect(state.phase).toBe("finished");
    const finished = state as FinishedState;
    expect(finished.landlordCards.map((c) => c.id).sort()).toEqual([...bottomIds].sort());

    const finishedView = viewFor(finished, 1); // a farmer's redacted view of the finished game
    expect(finishedView.phase).toBe("finished");
    if (finishedView.phase !== "finished") throw new Error("unreachable");
    expect(finishedView.landlordCards.map((c) => c.id).sort()).toEqual([...bottomIds].sort());
  });
});
