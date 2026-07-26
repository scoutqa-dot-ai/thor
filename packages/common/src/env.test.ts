import { describe, expect, it } from "vitest";
import { envBaseUrl, getRunnerBaseUrl, matchesInternalSecret } from "./env.ts";

describe("env loader", () => {
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

  it("compares internal secrets by byte length before timing-safe equality", () => {
    expect(matchesInternalSecret("secret", "secret")).toBe(true);
    expect(matchesInternalSecret("secret", "wrong")).toBe(false);
    expect(matchesInternalSecret("é", "x")).toBe(false);
    expect(matchesInternalSecret("secret", undefined)).toBe(false);
  });
});
