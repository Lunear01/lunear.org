import { describe, expect, it } from "vitest";
import { engine, gameDefinition } from "../src/index";

describe("gameDefinition", () => {
  it("registers pescalo as a 2-5 seat game with the full engine", () => {
    expect(gameDefinition.id).toBe("pescalo");
    expect(gameDefinition.name).toBe("Pescalo");
    expect(gameDefinition.minSeats).toBe(2);
    expect(gameDefinition.maxSeats).toBe(5);
    expect(gameDefinition.engine).toBe(engine);
    expect(Object.keys(engine).sort()).toEqual(["applyAction", "createGame", "settle", "viewFor"]);
  });
});
