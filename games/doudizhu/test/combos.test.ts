import { describe, expect, it } from "vitest";
import { beats, classifyCombo, type Combo } from "../src/combos";
import { cardsOf } from "./helpers";

function classify(ids: readonly string[]): Combo | null {
  return classifyCombo(cardsOf(ids));
}

describe("classifyCombo: every recognized category", () => {
  it("single", () => {
    expect(classify(["3S"])).toMatchObject({ category: "single", mainRank: 3, length: 1 });
  });

  it("pair", () => {
    expect(classify(["3S", "3H"])).toMatchObject({ category: "pair", mainRank: 3, length: 1 });
  });

  it("triple (no kicker)", () => {
    expect(classify(["3S", "3H", "3D"])).toMatchObject({ category: "triple", mainRank: 3, length: 1 });
  });

  it("triple + single kicker", () => {
    expect(classify(["3S", "3H", "3D", "5S"])).toMatchObject({
      category: "triplePlusSingle",
      mainRank: 3,
      length: 1,
    });
  });

  it("triple + pair kicker", () => {
    expect(classify(["3S", "3H", "3D", "5S", "5H"])).toMatchObject({
      category: "triplePlusPair",
      mainRank: 3,
      length: 1,
    });
  });

  it("straight, minimum length 5", () => {
    expect(classify(["3S", "4S", "5S", "6S", "7S"])).toMatchObject({
      category: "straight",
      mainRank: 3,
      length: 5,
    });
  });

  it("straight up to Ace (longest possible run, 3..A)", () => {
    const ids = ["3S", "4S", "5S", "6S", "7S", "8S", "9S", "10S", "JS", "QS", "KS", "AS"];
    expect(classify(ids)).toMatchObject({ category: "straight", mainRank: 3, length: 12 });
  });

  it("pair straight, minimum length 3 pairs", () => {
    expect(classify(["3S", "3H", "4S", "4H", "5S", "5H"])).toMatchObject({
      category: "pairStraight",
      mainRank: 3,
      length: 3,
    });
  });

  it("plane, no kicker (2 consecutive triples)", () => {
    expect(classify(["3S", "3H", "3D", "4S", "4H", "4D"])).toMatchObject({
      category: "plane",
      mainRank: 3,
      length: 2,
    });
  });

  it("plane + single kickers, kicker count equals triple count", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "7S", "8S"];
    expect(classify(ids)).toMatchObject({ category: "planePlusSingles", mainRank: 3, length: 2 });
  });

  it("plane + single kickers whose ranks are adjacent to the plane range (still legal)", () => {
    // plane = triples of 5,6; kickers = singles of 4 and 7 (adjacent, but distinct ranks from the plane).
    const ids = ["5S", "5H", "5D", "6S", "6H", "6D", "4S", "7S"];
    expect(classify(ids)).toMatchObject({ category: "planePlusSingles", mainRank: 5, length: 2 });
  });

  it("plane + pair kickers, kicker count equals triple count", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "7S", "7H", "8S", "8H"];
    expect(classify(ids)).toMatchObject({ category: "planePlusPairs", mainRank: 3, length: 2 });
  });

  it("plane of 3 consecutive triples", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "5S", "5H", "5D"];
    expect(classify(ids)).toMatchObject({ category: "plane", mainRank: 3, length: 3 });
  });

  it("four + two singles", () => {
    expect(classify(["5S", "5H", "5D", "5C", "7S", "8S"])).toMatchObject({
      category: "fourPlusTwoSingles",
      mainRank: 5,
    });
  });

  it("four + two singles: the two singles may share a rank (still just 2 attachments)", () => {
    expect(classify(["5S", "5H", "5D", "5C", "7S", "7H"])).toMatchObject({
      category: "fourPlusTwoSingles",
      mainRank: 5,
    });
  });

  it("four + two pairs", () => {
    const ids = ["5S", "5H", "5D", "5C", "7S", "7H", "8S", "8H"];
    expect(classify(ids)).toMatchObject({ category: "fourPlusTwoPairs", mainRank: 5 });
  });

  it("bomb", () => {
    expect(classify(["5S", "5H", "5D", "5C"])).toMatchObject({ category: "bomb", mainRank: 5 });
  });

  it("rocket (both jokers)", () => {
    expect(classify(["BJ", "RJ"])).toMatchObject({ category: "rocket" });
  });

  it("a lone triple of 2s is legal (the 3..A restriction only applies to sequences)", () => {
    expect(classify(["2S", "2H", "2D"])).toMatchObject({ category: "triple", mainRank: 15 });
  });

  it("a lone triple of 2s with a kicker is legal", () => {
    expect(classify(["2S", "2H", "2D", "5S"])).toMatchObject({ category: "triplePlusSingle", mainRank: 15 });
  });
});

describe("classifyCombo: illegal shapes rejected", () => {
  it("straight containing a 2", () => {
    const ids = ["10S", "JS", "QS", "KS", "AS", "2S"];
    expect(classify(ids)).toBeNull();
  });

  it("straight containing a joker", () => {
    const ids = ["9S", "10S", "JS", "QS", "KS", "BJ"];
    expect(classify(ids)).toBeNull();
  });

  it("straight shorter than 5 is not a combo", () => {
    expect(classify(["3S", "4S", "5S", "6S"])).toBeNull();
  });

  it("pair straight of length 2 (below the 3-pair minimum)", () => {
    expect(classify(["5S", "5H", "6S", "6H"])).toBeNull();
  });

  it("pair straight containing a 2", () => {
    const ids = ["KS", "KH", "AS", "AH", "2S", "2H"];
    expect(classify(ids)).toBeNull();
  });

  it("plane of triples that are not consecutive", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "7S", "7H", "7D"];
    expect(classify(ids)).toBeNull();
  });

  it("plane cannot include a triple of 2s", () => {
    const ids = ["KS", "KH", "KD", "2S", "2H", "2D"];
    expect(classify(ids)).toBeNull();
  });

  it("plane kicker count must equal triple count (too few kickers)", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "7S"];
    expect(classify(ids)).toBeNull();
  });

  it("plane kickers cannot mix singles and pairs", () => {
    const ids = ["3S", "3H", "3D", "4S", "4H", "4D", "7S", "8S", "8H"];
    expect(classify(ids)).toBeNull();
  });

  it("plane kicker overlapping the plane (leftover 4th copy of a triple's rank used as kicker)", () => {
    // triples of 5,6 (using 3 copies each) plus a "kicker" that is the 4th copy of rank 5 + one more single.
    const ids = ["5S", "5H", "5D", "6S", "6H", "6D", "5C", "9S"];
    expect(classify(ids)).toBeNull();
  });

  it("four + two with mismatched kickers (one single + one pair)", () => {
    const ids = ["5S", "5H", "5D", "5C", "7S", "8S", "8H"];
    expect(classify(ids)).toBeNull();
  });

  it("four + two with mismatched kickers (a triple + a single instead of two pairs)", () => {
    const ids = ["5S", "5H", "5D", "5C", "7S", "7H", "7D", "9S"];
    expect(classify(ids)).toBeNull();
  });

  it("two unrelated singles is not a combo", () => {
    expect(classify(["3S", "9H"])).toBeNull();
  });

  it("two unrelated pairs is not a combo", () => {
    expect(classify(["3S", "3H", "9S", "9H"])).toBeNull();
  });

  it("the same card selected twice is invalid", () => {
    const card = cardsOf(["3S"])[0];
    expect(classifyCombo([card, card])).toBeNull();
  });

  it("empty selection is invalid", () => {
    expect(classifyCombo([])).toBeNull();
  });

  it("two quads together (e.g. 4444+7777) is not a combo, even though each half is a bomb", () => {
    const ids = ["4S", "4H", "4D", "4C", "7S", "7H", "7D", "7C"];
    expect(classify(ids)).toBeNull();
  });
});

describe("beats: comparison matrix", () => {
  const straight = classify(["3S", "4S", "5S", "6S", "7S"])!;
  const longerStraight = classify(["3S", "4S", "5S", "6S", "7S", "8S"])!;
  const bomb5 = classify(["5S", "5H", "5D", "5C"])!;
  const bomb9 = classify(["9S", "9H", "9D", "9C"])!;
  const rocket = classify(["BJ", "RJ"])!;
  const pair5 = classify(["5S", "5H"])!;
  const pair5other = classify(["5D", "5C"])!;
  const pair9 = classify(["9S", "9H"])!;
  const fourPlusTwo5 = classify(["5S", "5H", "5D", "5C", "3S", "3H", "9S", "9H"])!; // fourPlusTwoPairs, mainRank 5

  it("bomb beats any non-bomb, non-rocket combo (e.g. a straight)", () => {
    expect(beats(straight, bomb5)).toBe(true);
  });

  it("a straight never beats a bomb", () => {
    expect(beats(bomb5, straight)).toBe(false);
  });

  it("rocket beats a bomb", () => {
    expect(beats(bomb9, rocket)).toBe(true);
  });

  it("nothing beats rocket, not even another bomb", () => {
    expect(beats(rocket, bomb9)).toBe(false);
    expect(beats(rocket, rocket)).toBe(false);
  });

  it("a bigger bomb beats a smaller bomb", () => {
    expect(beats(bomb5, bomb9)).toBe(true);
    expect(beats(bomb9, bomb5)).toBe(false);
  });

  it("same category + same length + higher rank beats", () => {
    expect(beats(pair5, pair9)).toBe(true);
  });

  it("same category, length mismatch is rejected", () => {
    expect(beats(straight, longerStraight)).toBe(false);
  });

  it("equal rank does not beat (strictly greater required)", () => {
    expect(beats(pair5, pair5other)).toBe(false);
  });

  it("four+two is not a universal bomb: it does not beat an unrelated straight", () => {
    expect(beats(straight, fourPlusTwo5)).toBe(false);
  });

  it("a straight cannot beat a four+two of the same 'rank family' (different categories)", () => {
    expect(beats(fourPlusTwo5, straight)).toBe(false);
  });
});
