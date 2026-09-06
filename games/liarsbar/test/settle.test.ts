import { describe, expect, it } from "vitest";
import { settle, type FinishedState, type PlayerStatus, type RevealRecord } from "../src/game";

function status(alive: boolean, pulls = 1, bulletChamber = 6): PlayerStatus {
  return { alive, pulls, bulletChamber };
}

const dummyReveal: RevealRecord = {
  playSeat: 0,
  challengerSeat: 1,
  cards: [],
  wasTruthful: false,
  loserSeat: 0,
  auto: false,
};

describe("settle: zero-sum for a real 4-seat game (3 eliminated, 1 winner)", () => {
  it("winner gets 3x baseStake; each of the 3 eliminated seats loses baseStake", () => {
    const finished: FinishedState = {
      phase: "finished",
      baseStake: 100,
      winner: 3,
      players: { 0: status(false), 1: status(false), 2: status(false), 3: status(true) },
      lastReveal: dummyReveal,
    };
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: -100, 1: -100, 2: -100, 3: 300 });
    expect(deltas[0] + deltas[1] + deltas[2] + deltas[3]).toBe(0);
  });
});

describe("settle: zero-sum for synthetic states with fewer eliminations", () => {
  it("1 elimination: winner gets 1x baseStake, the other two alive-but-not-winner seats get 0", () => {
    const finished: FinishedState = {
      phase: "finished",
      baseStake: 50,
      winner: 1,
      players: { 0: status(false), 1: status(true), 2: status(true), 3: status(true) },
      lastReveal: dummyReveal,
    };
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: -50, 1: 50, 2: 0, 3: 0 });
    expect(deltas[0] + deltas[1] + deltas[2] + deltas[3]).toBe(0);
  });

  it("2 eliminations: winner gets 2x baseStake, the remaining alive-but-not-winner seat gets 0", () => {
    const finished: FinishedState = {
      phase: "finished",
      baseStake: 50,
      winner: 2,
      players: { 0: status(false), 1: status(false), 2: status(true), 3: status(true) },
      lastReveal: dummyReveal,
    };
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: -50, 1: -50, 2: 100, 3: 0 });
    expect(deltas[0] + deltas[1] + deltas[2] + deltas[3]).toBe(0);
  });

  it("3 eliminations: winner gets 3x baseStake (the real-game shape)", () => {
    const finished: FinishedState = {
      phase: "finished",
      baseStake: 50,
      winner: 0,
      players: { 0: status(true), 1: status(false), 2: status(false), 3: status(false) },
      lastReveal: dummyReveal,
    };
    const deltas = settle(finished);
    expect(deltas).toEqual({ 0: 150, 1: -50, 2: -50, 3: -50 });
    expect(deltas[0] + deltas[1] + deltas[2] + deltas[3]).toBe(0);
  });
});

describe("settle: reads baseStake from state, not from a caller-supplied parameter", () => {
  it("two states differing only in baseStake produce proportionally different deltas", () => {
    const finishedAt10: FinishedState = {
      phase: "finished",
      baseStake: 10,
      winner: 0,
      players: { 0: status(true), 1: status(false), 2: status(false), 3: status(false) },
      lastReveal: dummyReveal,
    };
    const finishedAt30: FinishedState = { ...finishedAt10, baseStake: 30 };

    const deltasAt10 = settle(finishedAt10);
    const deltasAt30 = settle(finishedAt30);

    expect(deltasAt30[0]).toBe(deltasAt10[0] * 3);
    expect(deltasAt30[1]).toBe(deltasAt10[1] * 3);
    expect(deltasAt10).toEqual({ 0: 30, 1: -10, 2: -10, 3: -10 });
    expect(deltasAt30).toEqual({ 0: 90, 1: -30, 2: -30, 3: -30 });
  });
});
