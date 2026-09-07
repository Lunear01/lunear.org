import { describe, expect, it } from "vitest";
import { compareHands, evaluateBestHand, classifyFiveCardHand, type HandCategory } from "../src/evaluator";
import { cardsOf } from "./helpers";

function classify(ids: readonly string[]): ReturnType<typeof classifyFiveCardHand> {
  return classifyFiveCardHand(cardsOf(ids));
}

function best(ids: readonly string[]): ReturnType<typeof evaluateBestHand> {
  return evaluateBestHand(cardsOf(ids));
}

describe("classifyFiveCardHand: every category is recognized", () => {
  const cases: readonly [string, readonly string[], HandCategory][] = [
    ["high card", ["Ah", "Kd", "9c", "5s", "2h"], "high-card"],
    ["pair", ["Qh", "Qd", "9c", "5s", "2h"], "pair"],
    ["two pair", ["Qh", "Qd", "9c", "9s", "2h"], "two-pair"],
    ["trips", ["9h", "9d", "9c", "5s", "2h"], "trips"],
    ["straight (ace-high)", ["Ah", "Kd", "Qc", "Js", "Th"], "straight"],
    ["straight (wheel, ace-low)", ["Ah", "2d", "3c", "4s", "5h"], "straight"],
    ["flush", ["2h", "5h", "9h", "Jh", "Kh"], "flush"],
    ["full house", ["9h", "9d", "9c", "5s", "5h"], "full-house"],
    ["quads", ["9h", "9d", "9c", "9s", "Ah"], "quads"],
    ["straight flush", ["5h", "6h", "7h", "8h", "9h"], "straight-flush"],
    ["straight flush (wheel)", ["Ah", "2h", "3h", "4h", "5h"], "straight-flush"],
    ["straight flush (royal)", ["Th", "Jh", "Qh", "Kh", "Ah"], "straight-flush"],
  ];
  for (const [label, ids, expected] of cases) {
    it(`recognizes ${label}`, () => {
      expect(classify(ids).category).toBe(expected);
    });
  }
});

describe("classifyFiveCardHand: ranks arrays are shaped for correct comparison", () => {
  it("high card: all 5 ranks, descending", () => {
    expect(classify(["Ah", "Kd", "9c", "5s", "2h"]).ranks).toEqual([14, 13, 9, 5, 2]);
  });
  it("pair: [pairRank, kicker, kicker, kicker] descending", () => {
    expect(classify(["Qh", "Qd", "9c", "5s", "2h"]).ranks).toEqual([12, 9, 5, 2]);
  });
  it("two pair: [highPair, lowPair, kicker]", () => {
    expect(classify(["Qh", "Qd", "9c", "9s", "2h"]).ranks).toEqual([12, 9, 2]);
  });
  it("trips: [tripsRank, kicker, kicker]", () => {
    expect(classify(["9h", "9d", "9c", "5s", "2h"]).ranks).toEqual([9, 5, 2]);
  });
  it("straight / straight-flush: [highCard], wheel reports 5 not 14", () => {
    expect(classify(["Ah", "Kd", "Qc", "Js", "Th"]).ranks).toEqual([14]);
    expect(classify(["Ah", "2d", "3c", "4s", "5h"]).ranks).toEqual([5]);
    expect(classify(["Ah", "2h", "3h", "4h", "5h"]).ranks).toEqual([5]);
  });
  it("flush: all 5 ranks, descending", () => {
    expect(classify(["2h", "5h", "9h", "Jh", "Kh"]).ranks).toEqual([13, 11, 9, 5, 2]);
  });
  it("full house: [tripsRank, pairRank]", () => {
    expect(classify(["9h", "9d", "9c", "5s", "5h"]).ranks).toEqual([9, 5]);
  });
  it("quads: [quadRank, kicker]", () => {
    expect(classify(["9h", "9d", "9c", "9s", "Ah"]).ranks).toEqual([9, 14]);
  });
});

describe("compareHands: category strength ordering", () => {
  const ordered: readonly (readonly string[])[] = [
    ["Ah", "Kd", "9c", "5s", "2h"], // high card
    ["Qh", "Qd", "9c", "5s", "2h"], // pair
    ["Qh", "Qd", "9c", "9s", "2h"], // two pair
    ["9h", "9d", "9c", "5s", "2h"], // trips
    ["Ah", "Kd", "Qc", "Js", "Th"], // straight
    ["2h", "5h", "9h", "Jh", "Kh"], // flush
    ["9h", "9d", "9c", "5s", "5h"], // full house
    ["9h", "9d", "9c", "9s", "Ah"], // quads
    ["5h", "6h", "7h", "8h", "9h"], // straight flush
  ];
  it("each category strictly beats every category before it", () => {
    for (let i = 1; i < ordered.length; i++) {
      const weaker = classify(ordered[i - 1]);
      const stronger = classify(ordered[i]);
      expect(compareHands(stronger, weaker)).toBeGreaterThan(0);
      expect(compareHands(weaker, stronger)).toBeLessThan(0);
    }
  });

  it("flush beats straight even when the straight's high card is much bigger", () => {
    const flush = classify(["2h", "5h", "9h", "Jh", "Kh"]);
    const straight = classify(["Ah", "Kd", "Qc", "Js", "Th"]); // ace-high straight
    expect(compareHands(flush, straight)).toBeGreaterThan(0);
  });

  it("a flush with lower cards still beats a straight (category trumps raw rank)", () => {
    const lowFlush = classify(["2h", "3h", "4h", "5h", "7h"]);
    const highStraight = classify(["Ah", "Kd", "Qc", "Js", "Th"]);
    expect(compareHands(lowFlush, highStraight)).toBeGreaterThan(0);
  });
});

describe("compareHands: kicker tiebreaks within every category", () => {
  it("high card: compares down the kicker chain", () => {
    const a = classify(["Ah", "Kd", "9c", "5s", "2h"]);
    const b = classify(["Ah", "Kd", "9c", "6s", "2h"]); // better 3rd kicker
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("pair: same pair, better kicker wins", () => {
    const a = classify(["Qh", "Qd", "9c", "5s", "2h"]);
    const b = classify(["Qc", "Qs", "9d", "6h", "2c"]); // same pair, better 2nd kicker
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("pair: higher pair always beats a lower pair regardless of kickers", () => {
    const lowPairBigKickers = classify(["2h", "2d", "Ac", "Ks", "Qh"]);
    const highPairSmallKickers = classify(["3h", "3d", "4c", "5s", "6h"]);
    expect(compareHands(highPairSmallKickers, lowPairBigKickers)).toBeGreaterThan(0);
  });

  it("two pair: better top pair wins even with a worse bottom pair", () => {
    const a = classify(["Kh", "Kd", "2c", "2s", "9h"]); // KK 22
    const b = classify(["Qh", "Qd", "Jc", "Js", "9h"]); // QQ JJ (higher bottom pair, lower top pair)
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it("two pair: same both pairs, kicker decides", () => {
    const a = classify(["Qh", "Qd", "9c", "9s", "2h"]);
    const b = classify(["Qc", "Qs", "9d", "9h", "3c"]);
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("trips: same trips rank, better kicker wins", () => {
    const a = classify(["9h", "9d", "9c", "5s", "2h"]);
    const b = classify(["9c", "9s", "9h", "6s", "2c"]); // same trips, better kicker (6 vs 5)
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("straight: higher top card wins, wheel is the lowest straight", () => {
    const wheel = classify(["Ah", "2d", "3c", "4s", "5h"]);
    const sixHigh = classify(["2h", "3d", "4c", "5s", "6h"]);
    expect(compareHands(sixHigh, wheel)).toBeGreaterThan(0);
  });

  it("flush: compares down the rank chain, not just the top card", () => {
    const a = classify(["2h", "5h", "9h", "Jh", "Kh"]);
    const b = classify(["3h", "6h", "9h", "Jh", "Kh"]); // same top 3, better bottom two
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("full house: bigger trips wins even against a bigger pair", () => {
    const tripsNinesPairKings = classify(["9h", "9d", "9c", "Ks", "Kh"]);
    const tripsTensPairTwos = classify(["Th", "Td", "Tc", "2s", "2h"]);
    expect(compareHands(tripsTensPairTwos, tripsNinesPairKings)).toBeGreaterThan(0);
  });

  it("full house: same trips, bigger pair wins", () => {
    const a = classify(["9h", "9d", "9c", "5s", "5h"]);
    const b = classify(["9s", "9c", "9h", "6s", "6h"]);
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("quads: same quad rank, better kicker wins", () => {
    const a = classify(["9h", "9d", "9c", "9s", "Kh"]);
    const b = classify(["9h", "9d", "9c", "9s", "Ah"]);
    expect(compareHands(b, a)).toBeGreaterThan(0);
  });

  it("straight flush: higher top card wins", () => {
    const nineHigh = classify(["5h", "6h", "7h", "8h", "9h"]);
    const royal = classify(["Th", "Jh", "Qh", "Kh", "Ah"]);
    expect(compareHands(royal, nineHigh)).toBeGreaterThan(0);
  });
});

describe("compareHands: exact ties", () => {
  it("identical hands compare equal", () => {
    const a = classify(["9h", "9d", "9c", "5s", "2h"]);
    const b = classify(["9s", "9c", "9h", "5c", "2d"]); // same ranks, different suits/instances
    expect(compareHands(a, b)).toBe(0);
  });
});

describe("evaluateBestHand: picks the best 5 of 7", () => {
  it("uses the best combination, not just the first 5 cards", () => {
    // Cards in "natural" order look like nothing; the real hand (trip nines) is scattered through.
    const result = best(["2h", "9h", "3d", "9d", "4c", "9c", "5s"]);
    expect(result.category).toBe("trips");
    expect(result.ranks).toEqual([9, 5, 4]);
  });

  it("finds a straight flush hidden across hole + board", () => {
    const result = best(["5h", "9h", "6h", "2c", "7h", "8h", "3s"]);
    expect(result.category).toBe("straight-flush");
    expect(result.ranks).toEqual([9]);
  });

  it("board-plays-best: both hole cards are irrelevant to the winning 5", () => {
    // Community alone (5 of the 7) is a full house; both hole cards are unrelated low singles.
    const holeCards = ["2c", "3d"];
    const community = ["9h", "9d", "9c", "5s", "5h"];
    const result = best([...holeCards, ...community]);
    expect(result.category).toBe("full-house");
    expect(result.ranks).toEqual([9, 5]);
    expect(new Set(result.cards.map((c) => c.id))).toEqual(new Set(community));
  });
});

describe("evaluateBestHand: split-pot ties (identical best fives from different hole cards)", () => {
  it("two players both playing the board produce an exact tie", () => {
    const community = ["Ah", "Kd", "Qc", "Js", "Th"]; // broadway straight, mixed suits (no flush)
    const playerA = best([...community, "2c", "2d"]); // pair of deuces, worse than the straight
    const playerB = best([...community, "3h", "3s"]); // pair of treys, also worse than the straight
    expect(playerA.category).toBe("straight");
    expect(playerB.category).toBe("straight");
    expect(compareHands(playerA, playerB)).toBe(0);
    expect(playerA.ranks).toEqual(playerB.ranks);
  });
});
