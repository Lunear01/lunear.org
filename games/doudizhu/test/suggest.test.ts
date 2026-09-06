import { describe, expect, it } from "vitest";
import type { Card } from "../src/cards";
import { beats, classifyCombo, type Combo } from "../src/combos";
import { suggestPlay } from "../src/suggest";
import { cardsOf } from "./helpers";

function combo(ids: readonly string[]): Combo {
  const c = classifyCombo(cardsOf(ids));
  if (!c) throw new Error(`test fixture is not a legal combo: ${ids.join(",")}`);
  return c;
}

function hand(ids: readonly string[]): Card[] {
  return cardsOf(ids);
}

function sortedIds(cards: readonly Card[] | null): string[] {
  return (cards ?? []).map((c) => c.id).sort();
}

/** Every suggestion must be a legal combo, and (when beating) must actually beat `lastPlay`. */
function assertLegal(result: Card[] | null, lastPlay: Combo | null): Combo {
  expect(result).not.toBeNull();
  const resultCombo = classifyCombo(result!);
  expect(resultCombo).not.toBeNull();
  if (lastPlay) {
    expect(beats(lastPlay, resultCombo!)).toBe(true);
  }
  return resultCombo!;
}

describe("suggestPlay: beating, minimal winning response per category", () => {
  it("single: cheapest single strictly above the target", () => {
    const h = hand(["5S", "8H", "10D", "KS"]);
    const lastPlay = combo(["8S"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["10D"]);
    assertLegal(result, lastPlay);
  });

  it("pair: cheapest pair strictly above the target", () => {
    const h = hand(["5S", "5H", "9S", "9H", "QS", "QH", "KS", "KH"]);
    const lastPlay = combo(["9D", "9C"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["QH", "QS"]);
    assertLegal(result, lastPlay);
  });

  it("triple: cheapest bare triple strictly above the target", () => {
    const h = hand(["3S", "3H", "3D", "7S", "7H", "7D", "10S", "10H", "10D"]);
    const lastPlay = combo(["5S", "5H", "5D"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["7D", "7H", "7S"]);
    assertLegal(result, lastPlay);
  });

  it("straight: cheapest same-length straight strictly above the target", () => {
    const h = hand(["4S", "5S", "6S", "7S", "8S", "10H", "JH", "QH", "KH", "AH"]);
    const lastPlay = combo(["3D", "4D", "5D", "6D", "7D"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["4S", "5S", "6S", "7S", "8S"]);
    assertLegal(result, lastPlay);
  });

  it("plane: cheapest same-length plane strictly above the target", () => {
    const h = hand([
      "6S", "6H", "6D", "7S", "7H", "7D",
      "10S", "10H", "10D", "JS", "JH", "JD",
    ]);
    const lastPlay = combo(["3S", "3H", "3D", "4S", "4H", "4D"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["6D", "6H", "6S", "7D", "7H", "7S"]);
    assertLegal(result, lastPlay);
  });

  it("four+two singles: cheapest quad plus available kickers", () => {
    const h = hand(["9S", "9H", "9D", "9C", "3S", "4S"]);
    const lastPlay = combo(["5S", "5H", "5D", "5C", "2H", "2D"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["3S", "4S", "9C", "9D", "9H", "9S"]);
    assertLegal(result, lastPlay);
  });
});

describe("suggestPlay: structural preservation", () => {
  it("doesn't break a bomb to beat a single when a loose higher single exists", () => {
    const h = hand(["5S", "5H", "5D", "5C", "9S"]);
    const lastPlay = combo(["7H"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["9S"]);
    assertLegal(result, lastPlay);
  });

  it("does use the bomb when it's the only beat available", () => {
    const h = hand(["3S", "3H", "3D", "3C", "4S", "5S"]);
    const lastPlay = combo(["KH"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["3C", "3D", "3H", "3S"]);
    const resultCombo = assertLegal(result, lastPlay);
    expect(resultCombo.category).toBe("bomb");
  });

  it("doesn't break a triple to answer a pair when a loose pair exists", () => {
    const h = hand(["5S", "5H", "5D", "9S", "9H"]);
    const lastPlay = combo(["4S", "4H"]);
    const result = suggestPlay(h, lastPlay);
    expect(sortedIds(result)).toEqual(["9H", "9S"]);
    assertLegal(result, lastPlay);
  });

  it("breaks a pair for a single only when it's the only way to beat", () => {
    const h = hand(["5S", "5H"]);
    const lastPlay = combo(["3H"]);
    const result = suggestPlay(h, lastPlay);
    const resultCombo = assertLegal(result, lastPlay);
    expect(resultCombo.category).toBe("single");
    expect(resultCombo.mainRank).toBe(5);
    expect(result).toHaveLength(1);
  });

  it("never suggests a bomb/rocket when allowBombs is false, even as the only beat", () => {
    const h = hand(["3S", "3H", "3D", "3C", "4S", "5S"]);
    const lastPlay = combo(["KH"]);
    const result = suggestPlay(h, lastPlay, { allowBombs: false });
    expect(result).toBeNull();
  });
});

describe("suggestPlay: null when unbeatable", () => {
  it("rocket was played: nothing beats it", () => {
    const h = hand(["3S", "3H", "3D", "3C", "4S", "4H", "4D", "4C"]);
    const lastPlay = combo(["BJ", "RJ"]);
    expect(suggestPlay(h, lastPlay)).toBeNull();
  });

  it("bomb was played and hand has no bigger bomb or rocket", () => {
    const h = hand(["3S", "3H", "3D", "4S", "4H", "4D"]);
    const lastPlay = combo(["2S", "2H", "2D", "2C"]);
    expect(suggestPlay(h, lastPlay)).toBeNull();
  });

  it("single '2' was played and hand has no bomb/rocket to answer with", () => {
    const h = hand(["3S", "4S", "5S"]);
    const lastPlay = combo(["2H"]);
    expect(suggestPlay(h, lastPlay)).toBeNull();
  });
});

describe("suggestPlay: leading", () => {
  it("instant win: the whole hand is itself one legal combo (straight)", () => {
    const h = hand(["3S", "4S", "5S", "6S", "7S"]);
    const result = suggestPlay(h, null);
    expect(sortedIds(result)).toEqual(sortedIds(h));
    assertLegal(result, null);
  });

  it("instant win: the whole hand is itself one legal combo (bomb)", () => {
    const h = hand(["5S", "5H", "5D", "5C"]);
    const result = suggestPlay(h, null);
    expect(sortedIds(result)).toEqual(sortedIds(h));
    assertLegal(result, null);
  });

  it("sheds a straight over a longer pair-straight when both are available (category precedence)", () => {
    const h = hand([
      "3S", "4S", "5S", "6S", "7S",
      "9S", "9H", "10S", "10H", "JS", "JH", "QS", "QH",
    ]);
    const result = suggestPlay(h, null);
    expect(sortedIds(result)).toEqual(["3S", "4S", "5S", "6S", "7S"]);
    assertLegal(result, null);
  });

  it("sheds a pair-straight when no straight is available", () => {
    const h = hand(["5S", "5H", "6S", "6H", "7S", "7H", "8S", "8H"]);
    const result = suggestPlay(h, null);
    const resultCombo = assertLegal(result, null);
    expect(resultCombo.category).toBe("pairStraight");
    expect(sortedIds(result)).toEqual(["5H", "5S", "6H", "6S", "7H", "7S", "8H", "8S"]);
  });

  it("sheds a plane when only bare triples are available (doesn't fragment them into a pair-straight)", () => {
    const h = hand(["6S", "6H", "6D", "7S", "7H", "7D", "8S", "8H", "8D"]);
    const result = suggestPlay(h, null);
    const resultCombo = assertLegal(result, null);
    expect(resultCombo.category).toBe("plane");
    expect(sortedIds(result)).toEqual(["6D", "6H", "6S", "7D", "7H", "7S", "8D", "8H", "8S"]);
  });

  it("no sequence available: leads the lowest safe single or pair", () => {
    const h = hand(["3S", "3H", "9S"]);
    const result = suggestPlay(h, null);
    expect(sortedIds(result)).toEqual(["3H", "3S"]);
    assertLegal(result, null);
  });

  it("no sequence available: a lower loose single beats a higher loose pair", () => {
    const h = hand(["3S", "9S", "9H"]);
    const result = suggestPlay(h, null);
    expect(sortedIds(result)).toEqual(["3S"]);
    assertLegal(result, null);
  });

  it("falls back to a bare triple when nothing loose (non-triple, non-bomb) is available", () => {
    const h = hand(["5S", "5H", "5D", "9S", "9H", "9D", "9C"]);
    const result = suggestPlay(h, null);
    const resultCombo = assertLegal(result, null);
    expect(resultCombo.category).toBe("triple");
    expect(sortedIds(result)).toEqual(["5D", "5H", "5S"]);
  });

  it("falls back to the lowest bomb only when the hand is nothing but bombs", () => {
    const h = hand(["5S", "5H", "5D", "5C", "9S", "9H", "9D", "9C"]);
    const result = suggestPlay(h, null);
    const resultCombo = assertLegal(result, null);
    expect(resultCombo.category).toBe("bomb");
    expect(sortedIds(result)).toEqual(["5C", "5D", "5H", "5S"]);
  });
});

describe("suggestPlay: determinism", () => {
  it("beating: identical inputs produce identical output across repeated calls", () => {
    const h = hand(["4S", "5S", "6S", "7S", "8S", "10H", "JH", "QH", "KH", "AH"]);
    const lastPlay = combo(["3D", "4D", "5D", "6D", "7D"]);
    const first = suggestPlay(hand(["4S", "5S", "6S", "7S", "8S", "10H", "JH", "QH", "KH", "AH"]), lastPlay);
    const second = suggestPlay(h, lastPlay);
    expect(second).toEqual(first);
  });

  it("leading: identical inputs produce identical output across repeated calls", () => {
    const idsList = ["5S", "5H", "6S", "6H", "7S", "7H", "8S", "8H"];
    const first = suggestPlay(hand(idsList), null);
    const second = suggestPlay(hand(idsList), null);
    expect(second).toEqual(first);
  });
});
