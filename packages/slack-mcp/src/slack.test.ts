import { describe, it, expect, vi } from "vitest";
import {
  postMessage,
  readThread,
  getChannelHistory,
  readSlackFile,
  type SlackAttachment,
  type SlackFile,
  type SlackDeps,
} from "./slack.js";

function mockClient(overrides: Record<string, Record<string, unknown>> = {}): SlackDeps {
  const fetchFn = vi.fn();

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
      files: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          file: {
            id: "FDEFAULT",
            name: "notes.txt",
            title: "notes",
            mimetype: "text/plain",
            filetype: "txt",
            url_private: "https://files.slack.com/files-pri/T123-FDEFAULT/notes.txt",
          },
          ...overrides.fileInfo,
        }),
      },
    } as unknown as SlackDeps["client"],
    token: "xoxb-test",
    fetchFn: fetchFn as unknown as typeof fetch,
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
    const attachments: SlackAttachment[] = [{ text: "context", fallback: "context" }];
    const files: SlackFile[] = [
      {
        id: "F123",
        name: "photo.jpg",
        mimetype: "image/jpeg",
        url_private: "https://files.slack.com/files-pri/T123-F123/photo.jpg",
      },
    ];
    const messages = [
      { ts: "1111.0000", text: "parent", user: "U1" },
      { ts: "1111.0001", text: "reply", user: "U2", attachments, files },
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
    const attachments: SlackAttachment[] = [
      { text: "history attachment", fallback: "history attachment" },
    ];
    const files: SlackFile[] = [
      {
        id: "F456",
        name: "wireframe.png",
        mimetype: "image/png",
        url_private: "https://files.slack.com/files-pri/T123-F456/wireframe.png",
      },
    ];
    const messages = [
      { ts: "2222.0000", text: "msg1", user: "U1" },
      { ts: "2222.0001", text: "msg2", user: "U2", attachments, files },
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

describe("readSlackFile", () => {
  it("returns inline text content from files.info", async () => {
    const deps = mockClient({
      fileInfo: {
        file: {
          id: "F123",
          name: "brief.md",
          title: "brief",
          mimetype: "text/markdown",
          filetype: "md",
        },
        content: "# Brief\nHello from Slack",
      },
    });

    const result = await readSlackFile("F123", 5_000_000, deps);

    expect(result).toEqual({
      kind: "text",
      file: {
        id: "F123",
        name: "brief.md",
        title: "brief",
        mimetype: "text/markdown",
        filetype: "md",
        pretty_type: undefined,
        size: undefined,
        permalink: undefined,
        url_private: undefined,
        url_private_download: undefined,
      },
      text: "# Brief\nHello from Slack",
      truncated: false,
      source: "inline",
    });
    expect(deps.client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expect(deps.fetchFn as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("downloads image files and returns base64 image content", async () => {
    const deps = mockClient({
      fileInfo: {
        file: {
          id: "FIMG",
          name: "photo.jpg",
          title: "photo",
          mimetype: "image/jpeg",
          filetype: "jpg",
          url_private_download: "https://files.slack.com/files-pri/T123-FIMG/photo.jpg",
        },
      },
    });
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "image/jpeg",
        "content-length": String(imageBytes.length),
      }),
      arrayBuffer: vi
        .fn()
        .mockResolvedValue(
          imageBytes.buffer.slice(
            imageBytes.byteOffset,
            imageBytes.byteOffset + imageBytes.byteLength,
          ),
        ),
    });

    const result = await readSlackFile("FIMG", 5_000_000, deps);

    expect(result).toEqual({
      kind: "image",
      file: {
        id: "FIMG",
        name: "photo.jpg",
        title: "photo",
        mimetype: "image/jpeg",
        filetype: "jpg",
        pretty_type: undefined,
        size: undefined,
        permalink: undefined,
        url_private: undefined,
        url_private_download: "https://files.slack.com/files-pri/T123-FIMG/photo.jpg",
      },
      mimeType: "image/jpeg",
      data: imageBytes.toString("base64"),
    });
    expect(deps.fetchFn).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T123-FIMG/photo.jpg",
      {
        headers: {
          Authorization: "Bearer xoxb-test",
        },
      },
    );
  });

  it("rejects downloads larger than max_bytes", async () => {
    const deps = mockClient({
      fileInfo: {
        file: {
          id: "FBIG",
          name: "large.txt",
          title: "large",
          mimetype: "text/plain",
          filetype: "txt",
          url_private_download: "https://files.slack.com/files-pri/T123-FBIG/large.txt",
        },
      },
    });
    (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "text/plain",
        "content-length": "99",
      }),
      arrayBuffer: vi.fn(),
    });

    await expect(readSlackFile("FBIG", 10, deps)).rejects.toThrow("exceeds max_bytes");
  });
});
