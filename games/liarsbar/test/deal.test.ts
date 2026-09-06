import { describe, expect, it } from "vitest";
import { dealHands, nextAliveSeat, nextAliveSeatWithCards, nextSeatInRotation, SEATS } from "../src/deal";
import { anyValidDeck, buildRoundDeck, cardsOf } from "./helpers";

describe("nextSeatInRotation", () => {
  it("wraps 0->1->2->3->0", () => {
    expect(nextSeatInRotation(0)).toBe(1);
    expect(nextSeatInRotation(1)).toBe(2);
    expect(nextSeatInRotation(2)).toBe(3);
    expect(nextSeatInRotation(3)).toBe(0);
  });
});

describe("dealHands", () => {
  it("throws on a deck that is not exactly 20 cards", () => {
    expect(() => dealHands(anyValidDeck().slice(0, 19), SEATS)).toThrow(/20 cards/);
    expect(() => dealHands([...anyValidDeck(), anyValidDeck()[0]], SEATS)).toThrow(/20 cards/);
  });

  it("gives each alive seat its fixed 5-card block in deck order", () => {
    const deck = anyValidDeck();
    const hands = dealHands(deck, SEATS);
    expect(hands[0]).toEqual(deck.slice(0, 5));
    expect(hands[1]).toEqual(deck.slice(5, 10));
    expect(hands[2]).toEqual(deck.slice(10, 15));
    expect(hands[3]).toEqual(deck.slice(15, 20));
  });

  it("gives a dead (non-alive) seat an empty hand, without shifting other seats' blocks", () => {
    const deck = anyValidDeck();
    const hands = dealHands(deck, [0, 2, 3]); // seat 1 not alive
    expect(hands[1]).toEqual([]);
    expect(hands[0]).toEqual(deck.slice(0, 5));
    expect(hands[2]).toEqual(deck.slice(10, 15)); // still its own fixed block, not shifted up
    expect(hands[3]).toEqual(deck.slice(15, 20));
  });

  it("supports exactly 2 alive seats (heads-up), each keeping their fixed block", () => {
    const deck = anyValidDeck();
    const hands = dealHands(deck, [1, 3]);
    expect(hands[0]).toEqual([]);
    expect(hands[1]).toEqual(deck.slice(5, 10));
    expect(hands[2]).toEqual([]);
    expect(hands[3]).toEqual(deck.slice(15, 20));
  });
});

function alive(...aliveSeats: readonly number[]) {
  const set = new Set(aliveSeats);
  return { 0: { alive: set.has(0) }, 1: { alive: set.has(1) }, 2: { alive: set.has(2) }, 3: { alive: set.has(3) } };
}

describe("nextAliveSeat", () => {
  it("returns the immediate next seat when everyone is alive", () => {
    const players = alive(0, 1, 2, 3);
    expect(nextAliveSeat(players, 0)).toBe(1);
    expect(nextAliveSeat(players, 3)).toBe(0);
  });

  it("skips dead seats", () => {
    const players = alive(0, 3); // 1 and 2 dead
    expect(nextAliveSeat(players, 0)).toBe(3);
    expect(nextAliveSeat(players, 3)).toBe(0);
  });

  it("wraps around past seat 3 back to seat 0", () => {
    const players = alive(0, 1);
    expect(nextAliveSeat(players, 1)).toBe(0);
  });
});

describe("nextAliveSeatWithCards", () => {
  it("skips both dead seats and alive-but-empty-handed seats", () => {
    const players = alive(0, 1, 2, 3);
    const hands = {
      0: cardsOf(["Q1"]),
      1: [], // alive but empty-handed: skip
      2: cardsOf(["K1"]),
      3: [],
    };
    expect(nextAliveSeatWithCards(hands, players, 0)).toBe(2);
  });

  it("skips a dead seat even if it (hypothetically) still lists cards", () => {
    const players = alive(0, 2, 3); // seat 1 dead
    const hands = { 0: [], 1: cardsOf(["Q1"]), 2: cardsOf(["K1"]), 3: [] };
    expect(nextAliveSeatWithCards(hands, players, 0)).toBe(2);
  });

  it("throws when no alive seat with cards exists after fromSeat (invariant violation)", () => {
    const players = alive(0, 1);
    const hands = { 0: cardsOf(["Q1"]), 1: [], 2: [], 3: [] };
    expect(() => nextAliveSeatWithCards(hands, players, 0)).toThrow(/invariant/);
  });
});

describe("buildRoundDeck test helper", () => {
  it("places requested ids at the front of each seat's fixed 5-card block", () => {
    const deck = buildRoundDeck({ 0: ["Q1", "JOKER1"], 2: ["A5"] });
    expect(deck.length).toBe(20);
    expect(deck[0].id).toBe("Q1");
    expect(deck[1].id).toBe("JOKER1");
    expect(deck[10].id).toBe("A5");
    expect(new Set(deck.map((c) => c.id)).size).toBe(20); // every real card placed exactly once
  });
});
