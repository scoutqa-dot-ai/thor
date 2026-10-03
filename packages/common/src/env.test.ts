import { describe, expect, it } from "vitest";
import { matchesInternalSecret } from "./env.js";

describe("internal secret comparison", () => {
  it("compares internal secrets by byte length before timing-safe equality", () => {
    expect(matchesInternalSecret("secret", "secret")).toBe(true);
    expect(matchesInternalSecret("secret", "wrong")).toBe(false);
    expect(matchesInternalSecret("é", "x")).toBe(false);
    expect(matchesInternalSecret("secret", undefined)).toBe(false);
  });
});
