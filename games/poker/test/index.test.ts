import { describe, expect, it } from "vitest";
import { gameDefinition } from "../src/index";

describe("poker registry entry", () => {
  it("identifies itself for the platform registry", () => {
    expect(gameDefinition.id).toBe("poker");
    expect(gameDefinition.name).toBe("Poker");
    expect(gameDefinition.minSeats).toBe(2);
    expect(gameDefinition.maxSeats).toBe(8);
    expect(typeof gameDefinition.engine.createGame).toBe("function");
    expect(typeof gameDefinition.engine.applyAction).toBe("function");
    expect(typeof gameDefinition.engine.viewFor).toBe("function");
    expect(typeof gameDefinition.engine.settle).toBe("function");
  });
});
