import { describe, expect, it } from "vitest";
import { beats, classifyCombo, type Combo } from "../src/combos";
import { cardsOf } from "./helpers";

function combo(ids: readonly string[]): Combo {
  const result = classifyCombo(cardsOf(ids));
  if (!result) throw new Error(`expected a combo for ${ids.join(" ")}`);
  return result;
}

function category(ids: readonly string[]) {
  return classifyCombo(cardsOf(ids))?.category ?? null;
}

describe("classifyCombo — shapes", () => {
  it("classifies single, pair, triple", () => {
    expect(category(["7H"])).toBe("single");
    expect(category(["7H", "7S"])).toBe("pair");
    expect(category(["7H", "7S", "7D"])).toBe("triple");
  });

  it("rejects mismatched pairs and triples, and 4-card plays", () => {
    expect(category(["7H", "8S"])).toBeNull();
    expect(category(["7H", "7S", "8D"])).toBeNull();
    expect(category(["7H", "7S", "7D", "7C"])).toBeNull();
  });

  it("rejects empty and duplicate selections", () => {
    expect(classifyCombo([])).toBeNull();
    expect(category(["7H", "7H"])).toBeNull();
  });

  it("classifies the five-card hands", () => {
    expect(category(["3D", "4C", "5H", "6S", "7D"])).toBe("straight");
    expect(category(["3H", "6H", "9H", "JH", "KH"])).toBe("flush");
    expect(category(["9H", "9S", "9D", "4C", "4S"])).toBe("fullHouse");
    expect(category(["9H", "9S", "9D", "9C", "4S"])).toBe("fourOfAKind");
    expect(category(["5S", "6S", "7S", "8S", "9S"])).toBe("straightFlush");
  });

  it("rejects five-card junk: two pair, three plus two unrelated, near-straights", () => {
    expect(category(["9H", "9S", "4D", "4C", "KS"])).toBeNull();
    expect(category(["9H", "9S", "9D", "4C", "KS"])).toBeNull();
    expect(category(["3D", "4C", "5H", "6S", "8D"])).toBeNull();
  });
});

describe("classifyCombo — straight ladder", () => {
  it("allows 10-J-Q-K-A, A-2-3-4-5 and 2-3-4-5-6", () => {
    expect(category(["10D", "JC", "QH", "KS", "AD"])).toBe("straight");
    expect(category(["AD", "2C", "3H", "4S", "5D"])).toBe("straight");
    expect(category(["2D", "3C", "4H", "5S", "6D"])).toBe("straight");
  });

  it("rejects J-Q-K-A-2", () => {
    expect(category(["JD", "QC", "KH", "AS", "2D"])).toBeNull();
  });

  it("orders 2-3-4-5-6 above A-2-3-4-5 above 10-J-Q-K-A above 3-4-5-6-7", () => {
    const low = combo(["3D", "4C", "5H", "6S", "7D"]);
    const broadway = combo(["10D", "JC", "QH", "KS", "AD"]);
    const wheel = combo(["AC", "2C", "3C", "4S", "5D"]);
    const top = combo(["2H", "3S", "4D", "5C", "6H"]);
    expect(beats(low, broadway)).toBe(true);
    expect(beats(broadway, wheel)).toBe(true);
    expect(beats(wheel, top)).toBe(true);
    expect(beats(top, wheel)).toBe(false);
  });

  it("breaks equal straights by the suit of the top-ranked card", () => {
    const diamondTop = combo(["3D", "4C", "5H", "6S", "7D"]);
    const spadeTop = combo(["3C", "4H", "5S", "6D", "7S"]);
    expect(beats(diamondTop, spadeTop)).toBe(true);
    expect(beats(spadeTop, diamondTop)).toBe(false);
    // Wrap straights: the 2 is the top-ranked card.
    const wheelClubTwo = combo(["AS", "2C", "3C", "4S", "5D"]);
    const wheelSpadeTwo = combo(["AD", "2S", "3H", "4D", "5C"]);
    expect(beats(wheelClubTwo, wheelSpadeTwo)).toBe(true);
  });
});

describe("beats — singles, pairs, triples", () => {
  it("compares singles by rank then suit", () => {
    expect(beats(combo(["7H"]), combo(["7S"]))).toBe(true);
    expect(beats(combo(["7S"]), combo(["7H"]))).toBe(false);
    expect(beats(combo(["AS"]), combo(["2D"]))).toBe(true);
  });

  it("compares pairs by rank, then by the higher suit in the pair", () => {
    expect(beats(combo(["7D", "7C"]), combo(["7H", "7S"]))).toBe(true);
    expect(beats(combo(["7D", "7S"]), combo(["7H", "7C"]))).toBe(false);
    expect(beats(combo(["7H", "7S"]), combo(["8D", "8C"]))).toBe(true);
  });

  it("compares triples by rank", () => {
    expect(beats(combo(["7D", "7C", "7H"]), combo(["8D", "8C", "8H"]))).toBe(true);
    expect(beats(combo(["8D", "8C", "8H"]), combo(["7D", "7C", "7S"]))).toBe(false);
  });

  it("never lets a different card count beat a play", () => {
    expect(beats(combo(["7H"]), combo(["8H", "8S"]))).toBe(false);
    expect(beats(combo(["7H", "7S"]), combo(["3D", "4C", "5H", "6S", "7D"]))).toBe(false);
  });
});

describe("beats — five-card hands", () => {
  it("ranks straight < flush < full house < four of a kind < straight flush", () => {
    const straight = combo(["10D", "JC", "QH", "KS", "AD"]);
    const flush = combo(["3D", "5D", "8D", "9D", "JD"]);
    const fullHouse = combo(["4H", "4S", "4D", "KC", "KS"]);
    const quads = combo(["5H", "5S", "5D", "5C", "3S"]);
    const straightFlush = combo(["3H", "4H", "5H", "6H", "7H"]);
    expect(beats(straight, flush)).toBe(true);
    expect(beats(flush, fullHouse)).toBe(true);
    expect(beats(fullHouse, quads)).toBe(true);
    expect(beats(quads, straightFlush)).toBe(true);
    expect(beats(straightFlush, quads)).toBe(false);
    expect(beats(flush, straight)).toBe(false);
  });

  it("compares flushes by suit first, then top card", () => {
    const highDiamonds = combo(["3D", "5D", "8D", "9D", "AD"]);
    const lowClubs = combo(["3C", "4C", "6C", "8C", "9C"]);
    expect(beats(highDiamonds, lowClubs)).toBe(true);
    const higherDiamonds = combo(["4D", "6D", "7D", "10D", "2D"]);
    expect(beats(highDiamonds, higherDiamonds)).toBe(true);
    expect(beats(higherDiamonds, highDiamonds)).toBe(false);
  });

  it("compares full houses by the triple and four of a kind by the quad", () => {
    expect(beats(combo(["4H", "4S", "4D", "KC", "KS"]), combo(["5H", "5S", "5D", "3C", "3S"]))).toBe(true);
    expect(beats(combo(["KH", "KS", "KD", "3C", "3S"]), combo(["5H", "5S", "5D", "AC", "AS"]))).toBe(false);
    expect(beats(combo(["5H", "5S", "5D", "5C", "AS"]), combo(["6H", "6S", "6D", "6C", "3S"]))).toBe(true);
  });

  it("compares straight flushes like straights", () => {
    const low = combo(["3H", "4H", "5H", "6H", "7H"]);
    const high = combo(["3S", "4S", "5S", "6S", "7S"]);
    expect(beats(low, high)).toBe(true);
    const topLadder = combo(["2D", "3D", "4D", "5D", "6D"]);
    expect(beats(high, topLadder)).toBe(true);
  });
});
