import { describe, expect, it } from "vitest";
import { SUPPORTED_SLACK_CHANNEL_ID } from "./slack.ts";

describe("Slack helpers", () => {
  it("matches supported Slack channel targets", () => {
    expect(SUPPORTED_SLACK_CHANNEL_ID.test("C123")).toBe(true);
    expect(SUPPORTED_SLACK_CHANNEL_ID.test("G123")).toBe(true);
    expect(SUPPORTED_SLACK_CHANNEL_ID.test("U123")).toBe(false);
    expect(SUPPORTED_SLACK_CHANNEL_ID.test("D123")).toBe(false);
    expect(SUPPORTED_SLACK_CHANNEL_ID.test("general")).toBe(false);
  });
});
