import { describe, expect, it } from "vitest";
import {
  blindSeats,
  dealHoleCards,
  firstToActPostflop,
  firstToActPreflop,
  nextDealerSeat,
  nextOccupiedSeat,
  orderFrom,
  sortSeats,
} from "../src/deal";
import { anyValidDeck } from "./helpers";

describe("sortSeats", () => {
  it("sorts ascending regardless of input order", () => {
    expect(sortSeats([5, 0, 3])).toEqual([0, 3, 5]);
  });
});

describe("orderFrom: clockwise rotation, sparse seat numbers", () => {
  it("rotates to start at the given seat and wraps", () => {
    expect(orderFrom([0, 3, 5, 7], 5)).toEqual([5, 7, 0, 3]);
  });
  it("starting at the lowest seat is a no-op rotation", () => {
    expect(orderFrom([0, 3, 5, 7], 0)).toEqual([0, 3, 5, 7]);
  });
  it("throws if `start` is not an occupied seat", () => {
    expect(() => orderFrom([0, 3, 5], 4)).toThrow();
  });
});

describe("nextOccupiedSeat: sparse seat numbers, wraps past 7", () => {
  it("finds the next occupied seat strictly after `from`", () => {
    expect(nextOccupiedSeat([0, 3, 5, 7], 3)).toBe(5);
  });
  it("wraps around past the highest seat back to the lowest", () => {
    expect(nextOccupiedSeat([0, 3, 5, 7], 7)).toBe(0);
  });
  it("works even when `from` itself isn't occupied", () => {
    expect(nextOccupiedSeat([0, 3, 5, 7], 4)).toBe(5);
    expect(nextOccupiedSeat([0, 3, 5, 7], 6)).toBe(7);
  });
});

describe("nextDealerSeat", () => {
  it("rotates the button to the next occupied seat clockwise", () => {
    expect(nextDealerSeat([0, 2, 4], 0)).toBe(2);
    expect(nextDealerSeat([0, 2, 4], 4)).toBe(0); // wraps
  });
});

describe("blindSeats: heads-up is the standard exception", () => {
  it("2 players: the dealer posts the small blind (and thus acts first preflop)", () => {
    expect(blindSeats([0, 1], 0)).toEqual({ smallBlind: 0, bigBlind: 1 });
    expect(blindSeats([0, 1], 1)).toEqual({ smallBlind: 1, bigBlind: 0 });
  });

  it("2 players, non-adjacent seat numbers: same rule applies", () => {
    expect(blindSeats([2, 6], 6)).toEqual({ smallBlind: 6, bigBlind: 2 });
  });
});

describe("blindSeats: 3+ players, small blind is the next seat after the dealer", () => {
  it("3 players", () => {
    expect(blindSeats([0, 1, 2], 0)).toEqual({ smallBlind: 1, bigBlind: 2 });
  });

  it("8 players, dealer in the middle of the range", () => {
    expect(blindSeats([0, 1, 2, 3, 4, 5, 6, 7], 4)).toEqual({ smallBlind: 5, bigBlind: 6 });
  });

  it("sparse seat numbers", () => {
    expect(blindSeats([0, 3, 5, 7], 5)).toEqual({ smallBlind: 7, bigBlind: 0 });
  });
});

describe("firstToActPreflop / firstToActPostflop", () => {
  it("3+ players: preflop starts under the gun (after the big blind), postflop starts at the small blind", () => {
    const seats = [0, 1, 2, 3];
    const { smallBlind, bigBlind } = blindSeats(seats, 0);
    expect(firstToActPreflop(seats, bigBlind)).toBe(3); // UTG
    expect(firstToActPostflop(seats, 0)).toBe(smallBlind);
  });

  it("heads-up: preflop starts at the dealer/SB; postflop starts at the big blind (the inversion falls out for free)", () => {
    const seats = [0, 1];
    const { smallBlind, bigBlind } = blindSeats(seats, 0);
    expect(smallBlind).toBe(0);
    expect(bigBlind).toBe(1);
    expect(firstToActPreflop(seats, bigBlind)).toBe(0); // dealer/SB acts first preflop
    expect(firstToActPostflop(seats, 0)).toBe(1); // big blind acts first postflop
  });

  it("heads-up with non-adjacent seat numbers", () => {
    const seats = [2, 6];
    const { bigBlind } = blindSeats(seats, 6); // dealer = 6 = SB
    expect(bigBlind).toBe(2);
    expect(firstToActPreflop(seats, bigBlind)).toBe(6);
    expect(firstToActPostflop(seats, 6)).toBe(2);
  });
});

describe("dealHoleCards", () => {
  it("throws unless given exactly 52 cards", () => {
    expect(() => dealHoleCards(anyValidDeck().slice(0, 51), [0, 1])).toThrow();
  });

  it("deals 2 cards per seat, in ascending seat order, and leaves the rest for the board", () => {
    const deck = anyValidDeck();
    const { holeCards, remainingDeck } = dealHoleCards(deck, [5, 0, 3]);
    expect(holeCards[0]).toEqual([deck[0], deck[1]]);
    expect(holeCards[3]).toEqual([deck[2], deck[3]]);
    expect(holeCards[5]).toEqual([deck[4], deck[5]]);
    expect(remainingDeck).toEqual(deck.slice(6));
    expect(remainingDeck.length).toBe(52 - 6);
  });

  it("every dealt card is unique and none collide with the remaining deck", () => {
    const deck = anyValidDeck();
    const { holeCards, remainingDeck } = dealHoleCards(deck, [0, 1, 2, 3, 4, 5, 6, 7]);
    const dealtIds = Object.values(holeCards).flatMap((pair) => pair.map((c) => c.id));
    expect(new Set(dealtIds).size).toBe(16);
    expect(remainingDeck.length).toBe(52 - 16);
    expect(new Set([...dealtIds, ...remainingDeck.map((c) => c.id)]).size).toBe(52);
  });
});
