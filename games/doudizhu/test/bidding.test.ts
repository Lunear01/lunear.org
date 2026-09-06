import { describe, expect, it } from "vitest";
import { applyAction, createGame, type Action, type BiddingState } from "../src/game";
import { anyValidDeck } from "./helpers";

function newBidding(firstBidder: 0 | 1 | 2 = 0): BiddingState {
  return createGame({ shuffledDeck: anyValidDeck(), firstBidder, baseStake: 100 });
}

describe("bidding: all pass triggers a redeal signal", () => {
  it("phase becomes 'redeal' after three consecutive passes", () => {
    let state = newBidding(0);
    const r1 = applyAction(state, 0, { type: "pass" });
    expect(r1.ok).toBe(true);
    state = (r1 as { ok: true; state: BiddingState }).state;

    const r2 = applyAction(state, 1, { type: "pass" });
    expect(r2.ok).toBe(true);
    state = (r2 as { ok: true; state: BiddingState }).state;

    const r3 = applyAction(state, 2, { type: "pass" });
    expect(r3.ok).toBe(true);
    expect(r3.ok && r3.state.phase).toBe("redeal");

    // A redeal state accepts no further actions; the caller must reshuffle and createGame again.
    if (r3.ok) {
      expect(applyAction(r3.state, 0, { type: "pass" })).toEqual({ ok: false, reason: "wrong-phase" });
    }
  });
});

describe("bidding: bid 3 short-circuits", () => {
  it("ends bidding immediately even though other players have not acted", () => {
    const state = newBidding(0);
    const result = applyAction(state, 0, { type: "bid", amount: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state.phase).toBe("playing");
    if (result.state.phase !== "playing") throw new Error("unreachable");
    expect(result.state.landlord).toBe(0);
    expect(result.state.bidMultiplierBase).toBe(3);
    expect(result.state.currentTurn).toBe(0); // landlord leads
    expect(result.state.hands[0].length).toBe(20); // 17 dealt + 3 landlord cards
  });
});

describe("bidding: full round, highest bidder wins", () => {
  it("awards landlordship to the highest bid after all three have acted", () => {
    let state = newBidding(0);
    let result = applyAction(state, 0, { type: "bid", amount: 1 });
    expect(result.ok).toBe(true);
    state = (result as { ok: true; state: BiddingState }).state;

    result = applyAction(state, 1, { type: "bid", amount: 2 });
    expect(result.ok).toBe(true);
    state = (result as { ok: true; state: BiddingState }).state;

    result = applyAction(state, 2, { type: "pass" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state.phase).toBe("playing");
    if (result.state.phase !== "playing") throw new Error("unreachable");
    expect(result.state.landlord).toBe(1);
    expect(result.state.bidMultiplierBase).toBe(2);
    expect(result.state.hands[1].length).toBe(20);
  });
});

describe("bidding: rejections", () => {
  it("rejects a bid that does not exceed the current highest", () => {
    let state = newBidding(0);
    const first = applyAction(state, 0, { type: "bid", amount: 2 });
    state = (first as { ok: true; state: BiddingState }).state;

    const equal = applyAction(state, 1, { type: "bid", amount: 2 });
    expect(equal).toEqual({ ok: false, reason: "bid-too-low" });

    const lower = applyAction(state, 1, { type: "bid", amount: 1 });
    expect(lower).toEqual({ ok: false, reason: "bid-too-low" });
  });

  it("rejects an action from a seat that is not the current bidder", () => {
    const state = newBidding(0);
    const result = applyAction(state, 1, { type: "pass" });
    expect(result).toEqual({ ok: false, reason: "not-your-turn" });
  });

  it("rejects an out-of-range bid amount", () => {
    const state = newBidding(0);
    const action = { type: "bid", amount: 4 } as unknown as Action;
    const result = applyAction(state, 0, action);
    expect(result).toEqual({ ok: false, reason: "invalid-bid" });
  });

  it("rejects a play action during bidding", () => {
    const state = newBidding(0);
    const result = applyAction(state, 0, { type: "play", cardIds: ["3S"] });
    expect(result).toEqual({ ok: false, reason: "wrong-phase" });
  });
});
