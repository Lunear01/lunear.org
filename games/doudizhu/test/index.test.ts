import { describe, expect, it } from "vitest";
import { gameDefinition } from "../src/index";

describe("doudizhu stub registry entry", () => {
  it("identifies itself for the platform registry", () => {
    expect(gameDefinition.id).toBe("doudizhu");
    expect(gameDefinition.minSeats).toBe(3);
    expect(gameDefinition.maxSeats).toBe(3);
  });
});
