import { describe, expect, it } from "vitest";
import { gameDefinition } from "../src/index";

describe("blackjack registry entry", () => {
  it("identifies itself for the platform registry", () => {
    expect(gameDefinition.id).toBe("blackjack");
    expect(gameDefinition.name).toBe("Blackjack");
    expect(gameDefinition.minSeats).toBe(1);
    expect(gameDefinition.maxSeats).toBe(5);
    expect(typeof gameDefinition.engine.createGame).toBe("function");
    expect(typeof gameDefinition.engine.applyAction).toBe("function");
    expect(typeof gameDefinition.engine.viewFor).toBe("function");
    expect(typeof gameDefinition.engine.settle).toBe("function");
  });
});
