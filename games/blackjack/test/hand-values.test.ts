import { describe, expect, it } from "vitest";
import { handValue, isBust, isNatural } from "../src/game";
import { buildShoe } from "./helpers";
import { createShoe, type Card } from "../src/cards";

function cards(...labels: string[]): Card[] {
  const shoe = buildShoe([0], {
    hands: { 0: ["2c", "3c"] },
    dealer: ["4c", "5c"],
    draws: labels,
  });
  return shoe.slice(4, 4 + labels.length);
}

describe("handValue", () => {
  it("counts number cards at face value and faces as 10", () => {
    expect(handValue(cards("2c", "9d"))).toEqual({ total: 11, soft: false });
    expect(handValue(cards("Jc", "Qd", "Kh"))).toEqual({ total: 30, soft: false });
  });

  it("counts an ace as 11 while it fits (soft), 1 once it would bust", () => {
    expect(handValue(cards("Ac", "6d"))).toEqual({ total: 17, soft: true });
    expect(handValue(cards("Ac", "6d", "Th"))).toEqual({ total: 17, soft: false });
  });

  it("downgrades multiple aces one at a time", () => {
    expect(handValue(cards("Ac", "Ad"))).toEqual({ total: 12, soft: true });
    expect(handValue(cards("Ac", "Ad", "9h"))).toEqual({ total: 21, soft: true });
    expect(handValue(cards("Ac", "Ad", "9h", "Ks"))).toEqual({ total: 21, soft: false });
  });
});

describe("isNatural / isBust", () => {
  it("a natural is 21 from exactly the two dealt cards", () => {
    expect(isNatural(cards("Ac", "Kd"))).toBe(true);
    expect(isNatural(cards("7c", "7d", "7h"))).toBe(false);
    expect(isNatural(cards("Tc", "9d"))).toBe(false);
  });

  it("busts above 21 only", () => {
    expect(isBust(cards("Tc", "9d", "2h"))).toBe(false);
    expect(isBust(cards("Tc", "9d", "3h"))).toBe(true);
  });
});

describe("full-shoe sanity", () => {
  it("values a whole single deck with every ace forced down", () => {
    // 4x(2+..+10)=216, 12 faces x10=120, 4 aces downgraded to 1 each = 340.
    const value = handValue(createShoe(1));
    expect(value.total).toBe(340);
    expect(value.soft).toBe(false);
  });
});
