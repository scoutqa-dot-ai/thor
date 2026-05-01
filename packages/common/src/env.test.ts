import { describe, expect, it } from "vitest";
import { createEnvLoader, stripTrailingSlashes } from "./env.js";

describe("env loader", () => {
  it("reads required and optional strings with trim/default semantics", () => {
    const env = createEnvLoader({ REQUIRED: " value ", EMPTY: "   " });

    expect(env.string("REQUIRED")).toBe("value");
    expect(env.optionalString("MISSING", { defaultValue: "fallback" })).toBe("fallback");
    expect(env.optionalString("EMPTY", { defaultValue: "fallback" })).toBe("fallback");
    expect(() => env.string("MISSING")).toThrow("Missing required env var MISSING");
  });

  it("parses integers and preserves invalid integer failures", () => {
    const env = createEnvLoader({ PORT: "3000", BAD: "12abc", LOW: "0" });

    expect(env.int("PORT", { min: 1 })).toBe(3000);
    expect(env.int("MISSING", { defaultValue: 10 })).toBe(10);
    expect(() => env.int("BAD")).toThrow("BAD must be an integer");
    expect(() => env.int("LOW", { min: 1 })).toThrow("LOW must be >= 1");
  });

  it("parses booleans and csv lists", () => {
    const env = createEnvLoader({ ENABLED: "true", LIST: " a, b ,, c " });

    expect(env.bool("ENABLED")).toBe(true);
    expect(env.bool("MISSING", { defaultValue: false })).toBe(false);
    expect(env.csv("LIST")).toEqual(["a", "b", "c"]);
  });

  it("normalizes trailing slashes without regex backtracking", () => {
    const env = { URL: "https://example.test///" };

    expect(createEnvLoader(env).string("URL", { normalizeTrailingSlash: true })).toBe(
      "https://example.test",
    );
    expect(stripTrailingSlashes("https://example.test///")).toBe("https://example.test");
  });
});
