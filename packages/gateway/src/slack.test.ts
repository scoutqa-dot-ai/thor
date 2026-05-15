import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getSlackCorrelationKey,
  isForwardableSlackMessage,
  SlackEventEnvelopeSchema,
  verifySlackSignature,
} from "./slack.js";

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

  it("builds a thread-based correlation key with channel", () => {
    expect(
      getSlackCorrelationKey({
        type: "app_mention",
        user: "U123",
        text: "<@U999> hello",
        ts: "1710000000.111",
        thread_ts: "1710000000.000",
        channel: "C123",
      }),
    ).toBe("slack:thread:C123/1710000000.000");
  });

  it("preserves file_share metadata and unknown Slack fields", () => {
    const parsed = SlackEventEnvelopeSchema.parse({
      type: "event_callback",
      event_id: "EvFile",
      team_id: "T123",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U123",
        text: "",
        ts: "1710000000.002",
        thread_ts: "1710000000.001",
        channel: "C123",
        upload: true,
        files: [
          {
            id: "F123",
            name: "debug.log",
            mimetype: "text/plain",
            url_private: "https://files.slack.com/files-pri/T123-F123/debug.log",
            extra_file_field: { nested: true },
          },
        ],
      },
    });

    expect(parsed.event).toMatchObject({
      subtype: "file_share",
      text: "",
      upload: true,
      files: [{ id: "F123", extra_file_field: { nested: true } }],
    });
  });

  it("accepts nullable Slack file metadata fields", () => {
    const parsed = SlackEventEnvelopeSchema.parse({
      type: "event_callback",
      event_id: "EvFileNullable",
      team_id: "T123",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U123",
        text: "",
        ts: "1710000000.003",
        thread_ts: "1710000000.001",
        channel: "C123",
        files: [
          {
            id: "F124",
            name: null,
            title: null,
            mimetype: null,
            filetype: null,
            url_private: null,
            permalink: null,
            size: null,
          },
        ],
      },
    });

    expect(parsed.event).toMatchObject({
      subtype: "file_share",
      files: [
        {
          id: "F124",
          name: null,
          title: null,
          mimetype: null,
          filetype: null,
          url_private: null,
          permalink: null,
          size: null,
        },
      ],
    });
  });

  it("classifies only normal messages and supported subtypes as forwardable", () => {
    expect(isForwardableSlackMessage({ type: "message", ts: "1", channel: "C123" })).toBe(true);
    expect(
      isForwardableSlackMessage({
        type: "message",
        subtype: "thread_broadcast",
        ts: "1",
        channel: "C123",
      }),
    ).toBe(true);
    expect(
      isForwardableSlackMessage({
        type: "message",
        subtype: "message_changed",
        ts: "1",
        channel: "C123",
      }),
    ).toBe(false);
  });
});
