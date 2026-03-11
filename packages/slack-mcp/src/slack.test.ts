import { describe, it, expect, vi } from "vitest";
import { postMessage, readThread, getChannelHistory, type SlackDeps } from "./slack.js";

function mockClient(overrides: Record<string, Record<string, unknown>> = {}): SlackDeps {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({
          ok: true,
          ts: "1234.5678",
          channel: "C123",
          ...overrides.postMessage,
        }),
      },
      conversations: {
        replies: vi.fn().mockResolvedValue({
          ok: true,
          messages: [],
          has_more: false,
          ...overrides.replies,
        }),
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [],
          has_more: false,
          ...overrides.history,
        }),
      },
    } as unknown as SlackDeps["client"],
  };
}

describe("postMessage", () => {
  it("posts a message and returns ts + channel", async () => {
    const deps = mockClient();
    const result = await postMessage("C123", "hello", undefined, deps);

    expect(result).toEqual({ ts: "1234.5678", channel: "C123" });
    expect(deps.client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello",
    });
  });

  it("includes thread_ts when provided", async () => {
    const deps = mockClient();
    await postMessage("C123", "reply", "1111.2222", deps);

    expect(deps.client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "reply",
      thread_ts: "1111.2222",
    });
  });

  it("throws on Slack API error", async () => {
    const deps = mockClient({
      postMessage: { ok: false, error: "channel_not_found" },
    });
    // WebClient throws on non-ok responses
    (deps.client.chat.postMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("An API error occurred: channel_not_found"),
    );
    await expect(postMessage("C999", "hello", undefined, deps)).rejects.toThrow(
      "channel_not_found",
    );
  });
});

describe("readThread", () => {
  it("returns thread messages", async () => {
    const messages = [
      { ts: "1111.0000", text: "parent", user: "U1" },
      { ts: "1111.0001", text: "reply", user: "U2" },
    ];
    const deps = mockClient({ replies: { messages } });
    const result = await readThread("C123", "1111.0000", 50, deps);

    expect(result).toEqual(messages);
    expect(deps.client.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1111.0000",
      limit: 50,
    });
  });

  it("returns empty array when no messages", async () => {
    const deps = mockClient();
    const result = await readThread("C123", "1111.0000", 50, deps);
    expect(result).toEqual([]);
  });
});

describe("getChannelHistory", () => {
  it("returns channel messages", async () => {
    const messages = [
      { ts: "2222.0000", text: "msg1", user: "U1" },
      { ts: "2222.0001", text: "msg2", user: "U2" },
    ];
    const deps = mockClient({ history: { messages } });
    const result = await getChannelHistory("C123", 20, deps);

    expect(result).toEqual(messages);
    expect(deps.client.conversations.history).toHaveBeenCalledWith({
      channel: "C123",
      limit: 20,
    });
  });

  it("throws on SDK error", async () => {
    const deps = mockClient();
    (deps.client.conversations.history as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("An API error occurred: missing_scope"),
    );
    await expect(getChannelHistory("C123", 20, deps)).rejects.toThrow("missing_scope");
  });
});
