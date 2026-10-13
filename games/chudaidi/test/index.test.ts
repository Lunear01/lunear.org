import { describe, expect, it } from "vitest";
import { engine, gameDefinition } from "../src/index";

describe("chudaidi registry entry", () => {
  it("identifies itself for the platform registry", () => {
    expect(gameDefinition.id).toBe("chudaidi");
    expect(gameDefinition.minSeats).toBe(2);
    expect(gameDefinition.maxSeats).toBe(4);
    expect(gameDefinition.engine).toBe(engine);
    expect(typeof engine.createGame).toBe("function");
    expect(typeof engine.applyAction).toBe("function");
    expect(typeof engine.viewFor).toBe("function");
    expect(typeof engine.settle).toBe("function");
  });
});
