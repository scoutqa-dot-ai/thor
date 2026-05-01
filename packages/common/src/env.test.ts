import { describe, expect, it } from "vitest";
import { createEnvLoader, requireEnv, stripTrailingSlashes } from "./env.js";

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

  it("supports legacy parseInt-compatible integer parsing", () => {
    const env = createEnvLoader({ PORT: "03004x ", EMPTY: "", SPACES: "   " });

    expect(env.legacyInt("PORT", { defaultValue: 3000 })).toBe(3004);
    expect(env.legacyInt("EMPTY", { defaultValue: 3000 })).toBe(3000);
    expect(env.legacyInt("MISSING", { defaultValue: 3000 })).toBe(3000);
    expect(Number.isNaN(env.legacyInt("SPACES", { defaultValue: 3000 }))).toBe(true);
  });

  it("parses booleans and csv lists", () => {
    const env = createEnvLoader({ ENABLED: "true", LIST: " a, b ,, c " });

    expect(env.bool("ENABLED")).toBe(true);
    expect(env.bool("MISSING", { defaultValue: false })).toBe(false);
    expect(env.csv("LIST")).toEqual(["a", "b", "c"]);
  });

  it("normalizes trailing slashes and keeps requireEnv compatibility", () => {
    const env = { URL: "https://example.test///", REQUIRED: " ok " };

    expect(createEnvLoader(env).string("URL", { normalizeTrailingSlash: true })).toBe(
      "https://example.test",
    );
    expect(stripTrailingSlashes("https://example.test///")).toBe("https://example.test");
    expect(requireEnv("REQUIRED", env)).toBe("ok");
  });
});
