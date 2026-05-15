import { describe, expect, it } from "vitest";
import {
  envBaseUrl,
  envCsv,
  envInt,
  envOptionalString,
  envString,
  getRunnerBaseUrl,
} from "./env.js";

describe("env loader", () => {
  it("reads required and optional strings with trim/default semantics", () => {
    const env = { REQUIRED: " value ", EMPTY: "   " };

    expect(envString(env, "REQUIRED")).toBe("value");
    expect(envString(env, "MISSING", "fallback")).toBe("fallback");
    expect(envString(env, "EMPTY", "fallback")).toBe("fallback");
    expect(envOptionalString(env, "EMPTY")).toBeUndefined();
    expect(() => envString(env, "MISSING")).toThrow("Missing required env var MISSING");
  });

  it("parses integers and preserves invalid integer failures", () => {
    const env = { PORT: "3000", BAD: "12abc", LOW: "0" };

    expect(envInt(env, "PORT", undefined, 1)).toBe(3000);
    expect(envInt(env, "MISSING", 10)).toBe(10);
    expect(() => envInt(env, "BAD")).toThrow("BAD must be an integer");
    expect(() => envInt(env, "LOW", undefined, 1)).toThrow("LOW must be >= 1");
  });

  it("parses csv lists", () => {
    const env = { LIST: " a, b ,, c " };

    expect(envCsv(env, "LIST")).toEqual(["a", "b", "c"]);
  });

  it("reads RUNNER_BASE_URL", () => {
    expect(getRunnerBaseUrl({ RUNNER_BASE_URL: "https://thor.example.com" })).toBe(
      "https://thor.example.com",
    );
    expect(() => getRunnerBaseUrl({})).toThrow("Missing required env var RUNNER_BASE_URL");
  });

  it("strips trailing slashes from base URLs so callers can safely append paths", () => {
    expect(envBaseUrl({ API_URL: "https://api.example.com/" }, "API_URL")).toBe(
      "https://api.example.com",
    );
    expect(envBaseUrl({ API_URL: "https://api.example.com///" }, "API_URL")).toBe(
      "https://api.example.com",
    );
    expect(envBaseUrl({}, "API_URL", "https://default.example.com/")).toBe(
      "https://default.example.com",
    );
    expect(getRunnerBaseUrl({ RUNNER_BASE_URL: "https://thor.example.com/" })).toBe(
      "https://thor.example.com",
    );
  });
});
