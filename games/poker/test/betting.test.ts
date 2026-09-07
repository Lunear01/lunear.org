import { describe, expect, it } from "vitest";
import {
  applyAction,
  createGame,
  STARTING_STACK_MULTIPLE,
  type BettingState,
  type GameState,
  type PlayerHandState,
  type ShowdownState,
} from "../src/game";
import { act, buildDeck, expectRejected } from "./helpers";

const STAKE = 10;
const STACK = STARTING_STACK_MULTIPLE * STAKE; // 1000

function baseGame(seats: number[] = [0, 1, 2], dealerSeat = 0): BettingState {
  return createGame({ seats, dealerSeat, stake: STAKE, shuffledDeck: buildDeck(seats, {}) });
}

/**
 * A synthetic flop-phase state: hole cards and the leftover deck come from a real deal (so
 * they're guaranteed distinct and non-colliding), but the betting numbers (committed/streetCommitted/
 * folded per seat, currentBet, minRaiseIncrement, toAct, restricted) are whatever the test needs —
 * far simpler than scripting a full realistic sequence to reach a specific edge case.
 */
function flopState(
  playerOverrides: Partial<Record<number, Partial<PlayerHandState>>>,
  opts: Partial<Pick<BettingState, "currentBet" | "minRaiseIncrement" | "toAct" | "restricted" | "currentTurn">> = {},
  seats: number[] = [0, 1, 2],
  dealerSeat = 0,
): BettingState {
  const base = baseGame(seats, dealerSeat);
  const community = base.deck.slice(0, 3);
  const deck = base.deck.slice(3);
  const players: Record<number, PlayerHandState> = {};
  for (const seat of seats) {
    players[seat] = {
      holeCards: base.players[seat].holeCards,
      folded: false,
      committed: 0,
      streetCommitted: 0,
      ...playerOverrides[seat],
    };
  }
  const toAct = opts.toAct ?? seats.filter((s) => !players[s].folded);
  return {
    phase: "flop",
    seats,
    dealerSeat,
    stake: STAKE,
    players,
    community,
    deck,
    currentTurn: opts.currentTurn ?? toAct[0],
    toAct,
    currentBet: opts.currentBet ?? 0,
    minRaiseIncrement: opts.minRaiseIncrement ?? STAKE,
    restricted: opts.restricted ?? [],
  };
}

describe("createGame: structural validation (caller bugs, not typed rejections)", () => {
  it("throws for fewer than 2 or more than 8 seats", () => {
    expect(() => createGame({ seats: [0], dealerSeat: 0, stake: 10, shuffledDeck: buildDeck([0], {}) })).toThrow();
    const nine = [0, 1, 2, 3, 4, 5, 6, 7, 0]; // also duplicates, but length alone should already throw
    expect(() => createGame({ seats: nine, dealerSeat: 0, stake: 10, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
  });

  it("throws for duplicate seats", () => {
    expect(() => createGame({ seats: [0, 1, 1], dealerSeat: 0, stake: 10, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
  });

  it("throws for a seat number outside 0-7", () => {
    expect(() => createGame({ seats: [0, 8], dealerSeat: 0, stake: 10, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
  });

  it("throws when dealerSeat isn't one of seats", () => {
    expect(() => createGame({ seats: [0, 1, 2], dealerSeat: 5, stake: 10, shuffledDeck: buildDeck([0, 1, 2], {}) })).toThrow();
  });

  it("throws for a non-positive or non-integer stake", () => {
    expect(() => createGame({ seats: [0, 1], dealerSeat: 0, stake: 0, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
    expect(() => createGame({ seats: [0, 1], dealerSeat: 0, stake: -5, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
    expect(() => createGame({ seats: [0, 1], dealerSeat: 0, stake: 2.5, shuffledDeck: buildDeck([0, 1], {}) })).toThrow();
  });

  it("throws unless given exactly 52 cards", () => {
    expect(() => createGame({ seats: [0, 1], dealerSeat: 0, stake: 10, shuffledDeck: buildDeck([0, 1], {}).slice(0, 51) })).toThrow();
  });
});

describe("blind posting", () => {
  it("3 players: SB = stake/2, BB = stake; UTG (== dealer, 3-handed) acts first, BB gets the option last", () => {
    const state = baseGame([0, 1, 2], 0);
    expect(state.players[0].committed).toBe(0);
    expect(state.players[1].committed).toBe(5);
    expect(state.players[1].streetCommitted).toBe(5);
    expect(state.players[2].committed).toBe(10);
    expect(state.players[2].streetCommitted).toBe(10);
    expect(state.currentBet).toBe(10);
    expect(state.minRaiseIncrement).toBe(10);
    expect(state.currentTurn).toBe(0);
    expect(state.toAct).toEqual([0, 1, 2]);
  });

  it("small blind is floor(stake/2), minimum 1 — stake=1 rounds up to 1, not 0", () => {
    const state = createGame({ seats: [0, 1], dealerSeat: 0, stake: 1, shuffledDeck: buildDeck([0, 1], {}) });
    expect(state.players[0].committed).toBe(1);
    expect(state.players[1].committed).toBe(1);
  });

  it("odd stake rounds the small blind down", () => {
    const state = createGame({ seats: [0, 1], dealerSeat: 0, stake: 7, shuffledDeck: buildDeck([0, 1], {}) });
    expect(state.players[0].committed).toBe(3);
    expect(state.players[1].committed).toBe(7);
  });

  it("heads-up: the dealer posts the small blind and acts first preflop", () => {
    const state = createGame({ seats: [0, 1], dealerSeat: 0, stake: STAKE, shuffledDeck: buildDeck([0, 1], {}) });
    expect(state.players[0].committed).toBe(5);
    expect(state.players[1].committed).toBe(10);
    expect(state.currentTurn).toBe(0);
    expect(state.toAct).toEqual([0, 1]);
  });

  it("every seat's effective stack this hand is exactly 100x stake", () => {
    const state = createGame({ seats: [0, 1, 2], dealerSeat: 0, stake: 25, shuffledDeck: buildDeck([0, 1, 2], {}) });
    for (const seat of [0, 1, 2]) {
      const remaining = 100 * 25 - state.players[seat].committed;
      expect(remaining).toBeLessThanOrEqual(2500);
      expect(remaining).toBeGreaterThanOrEqual(2475); // blinds (<=25) are tiny relative to the stack
    }
  });

  it("8-seat game deals blinds correctly at non-contiguous seat numbers", () => {
    const state = createGame({
      seats: [0, 1, 2, 3, 4, 5, 6, 7],
      dealerSeat: 4,
      stake: STAKE,
      shuffledDeck: buildDeck([0, 1, 2, 3, 4, 5, 6, 7], {}),
    });
    expect(state.players[5].committed).toBe(5); // SB
    expect(state.players[6].committed).toBe(10); // BB
    expect(state.currentTurn).toBe(7); // UTG
    expect(state.toAct).toEqual([7, 0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("action order per street", () => {
  it("3-handed: preflop dealer(=UTG)->SB->BB; postflop SB->BB->dealer", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    expect((state as BettingState).currentTurn).toBe(0);
    state = act(state, 0, { type: "call" });
    expect((state as BettingState).currentTurn).toBe(1);
    state = act(state, 1, { type: "call" });
    expect((state as BettingState).currentTurn).toBe(2);
    state = act(state, 2, { type: "check" });
    expect(state.phase).toBe("flop");
    expect((state as BettingState).currentTurn).toBe(1);
    state = act(state, 1, { type: "check" });
    expect((state as BettingState).currentTurn).toBe(2);
    state = act(state, 2, { type: "check" });
    expect((state as BettingState).currentTurn).toBe(0);
  });

  it("heads-up: preflop dealer/SB acts first (and gets the option back last if called); postflop BB acts first", () => {
    let state: GameState = createGame({ seats: [0, 1], dealerSeat: 0, stake: STAKE, shuffledDeck: buildDeck([0, 1], {}) });
    expect((state as BettingState).currentTurn).toBe(0);
    state = act(state, 0, { type: "call" });
    expect((state as BettingState).currentTurn).toBe(1);
    state = act(state, 1, { type: "check" });
    expect(state.phase).toBe("flop");
    expect((state as BettingState).currentTurn).toBe(1);
    state = act(state, 1, { type: "check" });
    expect((state as BettingState).currentTurn).toBe(0);
  });
});

describe("legality: check", () => {
  it("cannot check while facing a live bet", () => {
    const state = baseGame([0, 1, 2], 0);
    expectRejected(state, 0, { type: "check" }, "cannot-check");
  });

  it("can check when nothing is owed (currentBet already matched)", () => {
    const state = flopState({}, { currentBet: 0 });
    expect(applyAction(state, state.currentTurn, { type: "check" }).ok).toBe(true);
  });
});

describe("legality: call", () => {
  it("calling with nothing owed is a harmless no-op (equivalent to check)", () => {
    const state = flopState({}, { currentBet: 0 });
    const result = applyAction(state, state.currentTurn, { type: "call" });
    expect(result.ok).toBe(true);
  });

  it("call matches the current bet exactly, using only the delta from the stack", () => {
    const state = flopState({ 1: { streetCommitted: 0 } }, { currentBet: 50, toAct: [1, 2], currentTurn: 1 }, [0, 1, 2]);
    const result = applyAction(state, 1, { type: "call" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const next = result.state as BettingState;
    expect(next.players[1].streetCommitted).toBe(50);
    expect(next.players[1].committed).toBe(50);
  });
});

describe("legality: bet", () => {
  it("rejects a bet when a bet is already live this street (should raise instead)", () => {
    const state = flopState({ 0: { streetCommitted: 20 } }, { currentBet: 20, toAct: [1, 2], currentTurn: 1 });
    expectRejected(state, 1, { type: "bet", amount: 50 }, "invalid-amount");
  });

  it("rejects a bet below the minimum (stake) when the player isn't forced all-in", () => {
    const state = flopState({}, { currentBet: 0 });
    expectRejected(state, state.currentTurn, { type: "bet", amount: 5 }, "bet-too-small");
  });

  it("accepts a bet of exactly the minimum (stake)", () => {
    const state = flopState({}, { currentBet: 0 });
    expect(applyAction(state, state.currentTurn, { type: "bet", amount: STAKE }).ok).toBe(true);
  });

  it("rejects a bet exceeding the player's stack (capped at stack -> rejection, never silently capped)", () => {
    const state = flopState({}, { currentBet: 0 });
    expectRejected(state, state.currentTurn, { type: "bet", amount: STACK + 1 }, "insufficient-stack");
  });

  it("accepts a bet of exactly the player's full remaining stack (all-in)", () => {
    const state = flopState({}, { currentBet: 0 });
    const result = applyAction(state, state.currentTurn, { type: "bet", amount: STACK });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const next = result.state as BettingState | ShowdownState;
    if (next.phase !== "showdown") {
      expect(next.players[state.currentTurn].committed).toBe(STACK);
    }
  });

  it("accepts an all-in bet below the minimum when it's the player's entire (short) remaining stack", () => {
    const seat = 0;
    const state = flopState({ [seat]: { committed: STACK - 4 } }, { currentBet: 0, toAct: [0, 1, 2], currentTurn: 0 });
    const result = applyAction(state, seat, { type: "bet", amount: 4 });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid amounts: zero, negative, non-integer", () => {
    const state = flopState({}, { currentBet: 0 });
    expectRejected(state, state.currentTurn, { type: "bet", amount: 0 }, "invalid-amount");
    expectRejected(state, state.currentTurn, { type: "bet", amount: -10 }, "invalid-amount");
    expectRejected(state, state.currentTurn, { type: "bet", amount: 10.5 }, "invalid-amount");
  });
});

describe("legality: raise", () => {
  it("rejects a raise when there's no bet yet this street (should bet instead)", () => {
    const state = flopState({}, { currentBet: 0 });
    expectRejected(state, state.currentTurn, { type: "raise", toAmount: 50 }, "invalid-amount");
  });

  it("rejects a raise that doesn't exceed the current bet", () => {
    const state = flopState({ 0: { streetCommitted: 20 } }, { currentBet: 20, toAct: [1, 2], currentTurn: 1 });
    expectRejected(state, 1, { type: "raise", toAmount: 20 }, "invalid-amount");
    expectRejected(state, 1, { type: "raise", toAmount: 15 }, "invalid-amount");
  });

  it("rejects a raise below the minimum increment when the player isn't forced all-in", () => {
    const state = flopState(
      { 0: { streetCommitted: 20 } },
      { currentBet: 20, minRaiseIncrement: 20, toAct: [1, 2], currentTurn: 1 },
    );
    expectRejected(state, 1, { type: "raise", toAmount: 30 }, "raise-too-small"); // increment 10 < 20
  });

  it("accepts a raise meeting exactly the minimum increment", () => {
    const state = flopState(
      { 0: { streetCommitted: 20 } },
      { currentBet: 20, minRaiseIncrement: 20, toAct: [1, 2], currentTurn: 1 },
    );
    expect(applyAction(state, 1, { type: "raise", toAmount: 40 }).ok).toBe(true);
  });

  it("rejects a raise exceeding the player's stack", () => {
    const state = flopState(
      { 0: { streetCommitted: 20 } },
      { currentBet: 20, minRaiseIncrement: 20, toAct: [1, 2], currentTurn: 1 },
    );
    expectRejected(state, 1, { type: "raise", toAmount: STACK + 1 }, "insufficient-stack");
  });

  it("accepts a raise to exactly 100x stake (all-in) but rejects one chip beyond it", () => {
    const state = flopState(
      { 0: { streetCommitted: 20 } },
      { currentBet: 20, minRaiseIncrement: 20, toAct: [1, 2], currentTurn: 1 },
    );
    expect(applyAction(state, 1, { type: "raise", toAmount: STACK }).ok).toBe(true);
    expectRejected(state, 1, { type: "raise", toAmount: STACK + 1 }, "insufficient-stack");
  });
});

describe("min-raise reopening rule", () => {
  it("a full raise reopens betting for every other active seat and clears any restriction", () => {
    const state = flopState(
      { 0: {}, 1: { streetCommitted: 100 }, 2: { streetCommitted: 100 } },
      { currentBet: 100, minRaiseIncrement: 100, toAct: [0], restricted: [1], currentTurn: 0 },
    );
    const result = applyAction(state, 0, { type: "raise", toAmount: 300 }); // increment 200 >= 100: full
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const next = result.state as BettingState;
    expect(next.restricted).toEqual([]);
    expect(next.minRaiseIncrement).toBe(200);
    expect(next.toAct.slice().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("a restricted seat cannot raise at all (regardless of amount) until reopened; call and fold remain available", () => {
    const state = flopState(
      { 0: {}, 1: { streetCommitted: 100 }, 2: {} },
      { currentBet: 100, minRaiseIncrement: 100, toAct: [1], restricted: [1], currentTurn: 1 },
    );
    expectRejected(state, 1, { type: "raise", toAmount: 500 }, "raise-too-small");
    expect(applyAction(state, 1, { type: "call" }).ok).toBe(true);
  });

  it("realistic end-to-end: a short all-in raise restricts the seats that already called the full bet", () => {
    // Flop, everyone carried 10 committed in from a preflop where all 3 called the big blind (990
    // stack left each). Seat 1 (first to act postflop) opens for 900 — a full bet, since
    // minRaiseIncrement resets to `stake` (10) at the start of every street. Seat 2 calls in full.
    // Seat 0 then shoves their entire remaining 990, which totals only 90 more than the 900 bet —
    // a "short" raise purely because it happens to land 90 short of a full (>=900) re-raise, not
    // because anyone chose to under-bet (this is the "short all-in only at exactly-stack
    // boundaries" case the spec calls out).
    let state: GameState = flopState(
      { 0: { committed: 10 }, 1: { committed: 10 }, 2: { committed: 10 } },
      { currentBet: 0, minRaiseIncrement: STAKE, toAct: [1, 2, 0], currentTurn: 1 },
    );
    state = act(state, 1, { type: "bet", amount: 900 });
    state = act(state, 2, { type: "call" });
    expect((state as BettingState).currentTurn).toBe(0);
    state = act(state, 0, { type: "raise", toAmount: 990 }); // seat0's entire remaining stack

    const afterShortRaise = state as BettingState;
    expect(afterShortRaise.currentBet).toBe(990);
    expect(afterShortRaise.minRaiseIncrement).toBe(900); // unchanged: a short raise doesn't reset the bar
    expect(afterShortRaise.restricted.slice().sort((a, b) => a - b)).toEqual([1, 2]);

    // Restricted seats' only remaining legal amount is the exact call (990); anything that would
    // read as a raise attempt is rejected regardless of reason precedence, since raising isn't
    // available to them at all right now.
    expectRejected(afterShortRaise, 1, { type: "raise", toAmount: 995 }, "raise-too-small");
    state = act(afterShortRaise, 1, { type: "call" });
    expectRejected(state as BettingState, 2, { type: "raise", toAmount: 995 }, "raise-too-small");
    state = act(state, 2, { type: "call" });

    // All three committed their full 1000-chip stack; nobody left who can act -> straight to showdown.
    expect(state.phase).toBe("showdown");
    for (const seat of [0, 1, 2]) {
      expect((state as ShowdownState).players[seat].committed).toBe(1000);
    }
  });
});

describe("betting-round closure", () => {
  it("closes the street once toAct empties and deals the next street with streetCommitted reset", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    state = act(state, 0, { type: "call" });
    state = act(state, 1, { type: "call" });
    state = act(state, 2, { type: "check" });
    const flop = state as BettingState;
    expect(flop.phase).toBe("flop");
    expect(flop.community.length).toBe(3);
    expect(flop.currentBet).toBe(0);
    expect(flop.minRaiseIncrement).toBe(STAKE);
    for (const seat of [0, 1, 2]) expect(flop.players[seat].streetCommitted).toBe(0);
  });

  it("all-in runout: once at most one active player remains, remaining streets are dealt with no more betting", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    state = act(state, 0, { type: "raise", toAmount: STACK }); // dealer shoves preflop
    state = act(state, 1, { type: "call" }); // SB calls all-in
    state = act(state, 2, { type: "call" }); // BB calls all-in
    // Nobody has any chips left to act with -> engine deals flop+turn+river and goes straight to showdown.
    expect(state.phase).toBe("showdown");
    const showdown = state as ShowdownState;
    expect(showdown.community.length).toBe(5);
    for (const seat of [0, 1, 2]) expect(showdown.players[seat].committed).toBe(STACK);
  });

  it("all-in runout starting mid-street: two players all-in on the flop still see the turn and river dealt", () => {
    let state: GameState = flopState(
      { 0: { committed: 10 }, 1: { committed: 10 } },
      { currentBet: 0, minRaiseIncrement: STAKE, toAct: [0, 1], currentTurn: 0 },
      [0, 1],
    );
    state = act(state, 0, { type: "bet", amount: STACK - 10 }); // seat0 shoves entire remaining stack
    state = act(state, 1, { type: "call" }); // seat1 calls all-in too
    expect(state.phase).toBe("showdown");
    const showdown = state as ShowdownState;
    expect(showdown.community.length).toBe(5);
  });
});

describe("fold-to-one early end", () => {
  it("preflop: everyone but one folds -> immediate uncontested finish, no community cards dealt", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    state = act(state, 0, { type: "fold" });
    state = act(state, 1, { type: "fold" });
    expect(state.phase).toBe("finished");
    if (state.phase !== "finished") throw new Error("unreachable");
    expect(state.winner).toBe(2);
    expect(state.community.length).toBe(0);
    expect(state.pot).toBe(state.players[0].committed + state.players[1].committed + state.players[2].committed);
  });

  it("mid-street fold also ends immediately, regardless of remaining streets", () => {
    const state = flopState(
      { 0: { committed: 50, folded: false }, 1: { committed: 100, folded: false } },
      { currentBet: 100, toAct: [0], currentTurn: 0 },
      [0, 1],
    );
    const result = applyAction(state, 0, { type: "fold" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state.phase).toBe("finished");
    if (result.state.phase !== "finished") throw new Error("unreachable");
    expect(result.state.winner).toBe(1);
    expect(result.state.pot).toBe(150);
  });

  it("heads-up: folding preflop forfeits the blinds to the opponent", () => {
    let state: GameState = createGame({ seats: [0, 1], dealerSeat: 0, stake: STAKE, shuffledDeck: buildDeck([0, 1], {}) });
    state = act(state, 0, { type: "fold" }); // dealer/SB folds without even calling
    expect(state.phase).toBe("finished");
    if (state.phase !== "finished") throw new Error("unreachable");
    expect(state.winner).toBe(1);
    expect(state.pot).toBe(15); // SB(5) + BB(10)
  });
});

describe("typed rejections not otherwise covered above", () => {
  it("not-your-turn", () => {
    const state = baseGame([0, 1, 2], 0);
    expectRejected(state, 1, { type: "call" }, "not-your-turn");
  });

  it("not-your-turn for a seat that isn't even in the game", () => {
    const state = baseGame([0, 1, 2], 0);
    expectRejected(state, 5, { type: "call" }, "not-your-turn");
  });

  it("folded-player-action: a folded seat can never act again, even out of turn", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    state = act(state, 0, { type: "fold" });
    expectRejected(state, 0, { type: "call" }, "folded-player-action");
  });

  it("wrong-phase: no action is accepted once the hand is over", () => {
    let state: GameState = baseGame([0, 1, 2], 0);
    state = act(state, 0, { type: "fold" });
    state = act(state, 1, { type: "fold" });
    expect(state.phase).toBe("finished");
    expectRejected(state, 2, { type: "check" }, "wrong-phase");
  });
});
