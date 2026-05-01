import { describe, expect, it } from "vitest";
import { getRunnerBaseUrl } from "./env.js";

describe("getRunnerBaseUrl", () => {
  it("requires RUNNER_BASE_URL and normalizes one trailing slash", () => {
    expect(() => getRunnerBaseUrl({})).toThrowError("Missing required env var RUNNER_BASE_URL");
    expect(() => getRunnerBaseUrl({ RUNNER_BASE_URL: "   " })).toThrowError("Missing required env var RUNNER_BASE_URL");

    expect(getRunnerBaseUrl({ RUNNER_BASE_URL: "https://thor.example.com/" })).toBe("https://thor.example.com");
  });
});
