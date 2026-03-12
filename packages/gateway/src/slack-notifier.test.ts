import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackNotifier } from "./slack-notifier.js";

function mockSlackClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "msg.001" }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as WebClient & {
    chat: {
      postMessage: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
}

function createNotifier(slack: ReturnType<typeof mockSlackClient>) {
  return new SlackNotifier({
    slack,
    channel: "C123",
    threadTs: "1710000000.001",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackNotifier", () => {
  it("does not post a message before the tool call threshold", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it("posts initial message on the 3rd tool call", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    expect(slack.chat.postMessage).toHaveBeenCalledOnce();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1710000000.001",
        text: expect.stringContaining("3 tool calls"),
      }),
    );
  });

  it("posts in the correct thread", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1710000000.001",
      }),
    );
  });

  it("shows last 3 tool names in the progress message", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    const text = slack.chat.postMessage.mock.calls[0][0].text as string;
    expect(text).toContain("last: Read, Grep, Edit");
  });

  it("keeps only the last 3 tool names as window slides", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    // Advance time past throttle so 4th call triggers an update
    vi.advanceTimersByTime(10_000);
    await notifier.onToolCall("Write");

    const text = slack.chat.update.mock.calls[0][0].text as string;
    expect(text).toContain("last: Grep, Edit, Write");
    expect(text).not.toContain("Read");
  });

  it("throttles updates to 10s intervals", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    // Hit threshold
    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");
    expect(slack.chat.postMessage).toHaveBeenCalledOnce();

    // 4th call immediately — should be throttled
    await notifier.onToolCall("Write");
    expect(slack.chat.update).not.toHaveBeenCalled();

    // Advance 10s, next call should trigger update
    vi.advanceTimersByTime(10_000);
    await notifier.onToolCall("Bash");
    expect(slack.chat.update).toHaveBeenCalledOnce();
  });

  it("updates the same message (uses ts from postMessage)", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    vi.advanceTimersByTime(10_000);
    await notifier.onToolCall("Write");

    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg.001",
      }),
    );
  });

  it("finish with completed status updates the message", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    vi.advanceTimersByTime(83_000); // 1m 23s
    await notifier.finish("completed");

    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/✅ Done — 3 tool calls in 1m 23s/),
      }),
    );
  });

  it("finish with error status includes error message", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    await notifier.finish("error", "context window exceeded");

    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("❌ Failed — context window exceeded after 3 tool calls"),
      }),
    );
  });

  it("finish with error uses default message when none provided", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    await notifier.finish("error");

    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("session error"),
      }),
    );
  });

  it("short run (below threshold) produces no Slack messages on finish", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.finish("completed");

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  it("finish is idempotent — second call is a no-op", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    await notifier.finish("completed");
    await notifier.finish("error", "should be ignored");

    // Only one update call (the first finish)
    expect(slack.chat.update).toHaveBeenCalledOnce();
    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("✅ Done"),
      }),
    );
  });

  it("onToolCall is a no-op after finish", async () => {
    const slack = mockSlackClient();
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");
    await notifier.finish("completed");

    slack.chat.postMessage.mockClear();
    slack.chat.update.mockClear();

    await notifier.onToolCall("Write");

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  it("handles postMessage failure gracefully", async () => {
    const slack = mockSlackClient();
    slack.chat.postMessage.mockRejectedValueOnce(new Error("channel_not_found"));
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    // Should not throw
    await notifier.onToolCall("Edit");

    expect(slack.chat.postMessage).toHaveBeenCalledOnce();
  });

  it("handles chat.update failure gracefully", async () => {
    const slack = mockSlackClient();
    slack.chat.update.mockRejectedValueOnce(new Error("message_not_found"));
    const notifier = createNotifier(slack);

    await notifier.onToolCall("Read");
    await notifier.onToolCall("Grep");
    await notifier.onToolCall("Edit");

    // Should not throw
    vi.advanceTimersByTime(10_000);
    await notifier.onToolCall("Write");

    expect(slack.chat.update).toHaveBeenCalledOnce();
  });
});
