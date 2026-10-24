import { describe, expect, it } from "vitest";
import { classifyCombo, type Combo } from "../src/combos";
import { suggestPlay } from "../src/suggest";
import { cardsOf } from "./helpers";

function combo(ids: readonly string[]): Combo {
  const result = classifyCombo(cardsOf(ids));
  if (!result) throw new Error(`expected a combo for ${ids.join(" ")}`);
  return result;
}

const HAND = cardsOf(["4D", "3S", "7H", "7S", "7D", "9C", "9S", "10H", "JH", "QH", "KH", "AH", "2D"]);

function ids(cards: readonly { id: string }[] | null): string[] | null {
  return cards === null ? null : cards.map((c) => c.id).sort();
}

describe("suggestPlay", () => {
  it("leads the lead card while the first-play rule is live", () => {
    expect(ids(suggestPlay(HAND, null, "4D"))).toEqual(["4D"]);
  });

  it("leads the weakest single on a free lead", () => {
    expect(ids(suggestPlay(HAND, null, null))).toEqual(["4D"]);
  });

  it("beats a single with the weakest stronger single", () => {
    expect(ids(suggestPlay(HAND, combo(["8C"]), null))).toEqual(["9C"]);
    expect(ids(suggestPlay(HAND, combo(["2S"]), null))).toEqual(["3S"]);
  });

  it("beats a pair with the weakest stronger pair, picking the lowest suits", () => {
    expect(ids(suggestPlay(HAND, combo(["5H", "5S"]), null))).toEqual(["7D", "7H"]);
    expect(ids(suggestPlay(HAND, combo(["7C", "7H"]), null))).toEqual(["7D", "7S"]);
  });

  it("beats a triple and a five-card hand with the weakest option", () => {
    expect(ids(suggestPlay(HAND, combo(["6D", "6C", "6H"]), null))).toEqual(["7D", "7H", "7S"]);
    // A straight on the table: 9-K is the weakest beating straight, below 10-A.
    expect(ids(suggestPlay(HAND, combo(["5D", "6C", "7C", "8S", "9D"]), null))).toEqual(["10H", "9C", "JH", "KH", "QH"]);
    // Four of a kind on the table: only the 10-A heart straight flush beats it.
    expect(ids(suggestPlay(HAND, combo(["5H", "5S", "5D", "5C", "4S"]), null))).toEqual(["10H", "AH", "JH", "KH", "QH"]);
    // A flush on the table: only the full house (7s over 9s) beats it.
    expect(ids(suggestPlay(HAND, combo(["4S", "6S", "8S", "10S", "KS"]), null))).toEqual(["7D", "7H", "7S", "9C", "9S"]);
  });

  it("returns null when nothing beats the play", () => {
    expect(suggestPlay(HAND, combo(["3D", "3H"]), null)).toBeNull();
    expect(suggestPlay(HAND, combo(["3D", "4D", "5D", "6D", "7D"]), null)).toBeNull();
    expect(suggestPlay(cardsOf(["4D"]), combo(["5H", "5S"]), null)).toBeNull();
  });
});
