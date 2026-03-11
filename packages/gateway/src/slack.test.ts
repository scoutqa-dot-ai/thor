import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getSlackCorrelationKey, verifySlackSignature } from "./slack.js";

function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("slack helpers", () => {
  it("verifies a valid Slack signature", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const timestamp = "1710000000";
    const secret = "top-secret";

    expect(
      verifySlackSignature({
        signingSecret: secret,
        rawBody: body,
        signature: sign(body, secret, timestamp),
        timestamp,
        nowSeconds: 1710000000,
      }),
    ).toBe(true);
  });

  it("rejects stale Slack signatures", () => {
    const body = JSON.stringify({ test: true });
    const timestamp = "1710000000";
    const secret = "top-secret";

    expect(
      verifySlackSignature({
        signingSecret: secret,
        rawBody: body,
        signature: sign(body, secret, timestamp),
        timestamp,
        nowSeconds: 1710001000,
        toleranceSeconds: 60,
      }),
    ).toBe(false);
  });

  it("builds a thread-based correlation key", () => {
    expect(
      getSlackCorrelationKey({
        type: "app_mention",
        user: "U123",
        text: "<@U999> hello",
        ts: "1710000000.111",
        thread_ts: "1710000000.000",
        channel: "C123",
      }),
    ).toBe("slack:thread:1710000000.000");
  });
});
