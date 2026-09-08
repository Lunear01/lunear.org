import { describe, expect, it } from "vitest";
import { gameDefinition } from "../src/index";

describe("liarsbar registry entry", () => {
  it("identifies itself for the platform registry", () => {
    expect(gameDefinition.id).toBe("liarsbar");
    expect(gameDefinition.name).toBe("Liar's Bar");
    expect(gameDefinition.minSeats).toBe(2);
    expect(gameDefinition.maxSeats).toBe(4);
    expect(typeof gameDefinition.engine.createGame).toBe("function");
    expect(typeof gameDefinition.engine.applyAction).toBe("function");
    expect(typeof gameDefinition.engine.startNextRound).toBe("function");
    expect(typeof gameDefinition.engine.viewFor).toBe("function");
    expect(typeof gameDefinition.engine.settle).toBe("function");
  });
});
