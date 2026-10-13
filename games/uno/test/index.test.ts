import { describe, expect, it } from "vitest";
import { engine, gameDefinition } from "../src/index";

describe("gameDefinition", () => {
  it("registers uno as a 2-6 seat game with the four engine verbs", () => {
    expect(gameDefinition.id).toBe("uno");
    expect(gameDefinition.name).toBe("UNO");
    expect(gameDefinition.minSeats).toBe(2);
    expect(gameDefinition.maxSeats).toBe(6);
    expect(gameDefinition.engine).toBe(engine);
    expect(typeof engine.createGame).toBe("function");
    expect(typeof engine.applyAction).toBe("function");
    expect(typeof engine.viewFor).toBe("function");
    expect(typeof engine.settle).toBe("function");
  });
});
