import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "@thor/common";
import {
  handleProgressEvent,
  onBotReply,
  getRegistrySize,
  clearRegistry,
} from "./progress-manager.js";
import type { SlackDeps } from "./slack.js";

function mockSlackDeps() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "msg.001", channel: "C123" }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    } as unknown as WebClient,
  } satisfies SlackDeps;
}

type MockDeps = ReturnType<typeof mockSlackDeps>;

function chat(deps: MockDeps) {
  const c = deps.client as unknown as {
    chat: {
      postMessage: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
  return c.chat;
}

async function sendTools(
  deps: MockDeps,
  count: number,
  channel = "C123",
  threadTs = "1710000000.001",
) {
  for (let i = 0; i < count; i++) {
    await handleProgressEvent(
      channel,
      threadTs,
      { type: "tool", tool: `Tool${i}`, status: "completed" },
      deps,
    );
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearRegistry();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProgressManager", () => {
  it("does not post a message before the tool call threshold", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 2);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
  });

  it("posts initial message on the 3rd tool call with context blocks", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    const call = chat(deps).postMessage.mock.calls[0][0];
    expect(call).toMatchObject({
      channel: "C123",
      thread_ts: "1710000000.001",
      text: expect.stringContaining("3 tool calls"),
    });
    // Verify context blocks are used for compact rendering
    expect(call.blocks).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: expect.stringContaining("3 tool calls") }],
      },
    ]);
  });

  it("shows last 3 tool names in the progress message", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const text = chat(deps).postMessage.mock.calls[0][0].text as string;
    expect(text).toContain("last: Tool0, Tool1, Tool2");
  });

  it("collapses consecutive duplicate tool names", async () => {
    const deps = mockSlackDeps();
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "start", sessionId: "s1", resumed: false },
      deps,
    );
    // Send 3 grep calls to hit threshold — 1 group
    for (let i = 0; i < 3; i++) {
      await handleProgressEvent(
        "C123",
        "1710000000.001",
        { type: "tool", tool: "Grep", status: "completed" },
        deps,
      );
    }

    const text = chat(deps).postMessage.mock.calls[0][0].text as string;
    expect(text).toContain("last: Grep x3");
  });

  it("collapses only consecutive duplicates, not all occurrences", async () => {
    const deps = mockSlackDeps();
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "start", sessionId: "s1", resumed: false },
      deps,
    );
    // Send: Write, Grep, Grep — 2 groups within 3 tools
    const tools = ["Write", "Grep", "Grep"];
    for (const tool of tools) {
      await handleProgressEvent(
        "C123",
        "1710000000.001",
        { type: "tool", tool, status: "completed" },
        deps,
      );
    }

    const text = chat(deps).postMessage.mock.calls[0][0].text as string;
    expect(text).toContain("last: Write, Grep x2");
  });

  it("keeps last 3 groups, not last 3 individual tools", async () => {
    const deps = mockSlackDeps();
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "start", sessionId: "s1", resumed: false },
      deps,
    );
    // Send: Write, Read, Grep, Grep, Read, Read — should show last 3 groups
    const tools = ["Write", "Read", "Grep", "Grep", "Read", "Read"];
    for (const tool of tools) {
      await handleProgressEvent(
        "C123",
        "1710000000.001",
        { type: "tool", tool, status: "completed" },
        deps,
      );
    }

    // Advance timer so next tool triggers an update
    vi.advanceTimersByTime(10_000);
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "tool", tool: "Grep", status: "completed" },
      deps,
    );

    // Last update should show last 3 groups: Grep x2, Read x2, Grep
    const updateCall = chat(deps).update.mock.calls[0][0];
    expect(updateCall.text).toContain("last: Grep x2, Read x2, Grep");
  });

  it("throttles updates to 10s intervals", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();

    // 4th call immediately — should be throttled
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "tool", tool: "Write", status: "completed" },
      deps,
    );
    expect(chat(deps).update).not.toHaveBeenCalled();

    // Advance 10s, next call should trigger update
    vi.advanceTimersByTime(10_000);
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "tool", tool: "Bash", status: "completed" },
      deps,
    );
    expect(chat(deps).update).toHaveBeenCalledOnce();
  });

  it("finish with completed status edits to done with context blocks", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const doneEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent("C123", "1710000000.001", doneEvent, deps);

    const call = chat(deps).update.mock.calls[0][0];
    expect(call).toMatchObject({
      channel: "C123",
      ts: "msg.001",
      text: expect.stringContaining("✅ Done"),
    });
    expect(call.blocks).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: expect.stringContaining("✅ Done") }],
      },
    ]);
    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(getRegistrySize()).toBe(1);
  });

  it("finish with error status includes error message", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const errorEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "context window exceeded",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent("C123", "1710000000.001", errorEvent, deps);

    expect(chat(deps).update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("❌ Failed — context window exceeded after 3 tool calls"),
      }),
    );
  });

  it("short run (below threshold) produces no Slack messages on finish", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 2);

    const doneEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 1000,
    };
    await handleProgressEvent("C123", "1710000000.001", doneEvent, deps);

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    expect(chat(deps).update).not.toHaveBeenCalled();
  });
});

describe("onBotReply", () => {
  it("deletes completed progress messages", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const doneEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent("C123", "1710000000.001", doneEvent, deps);
    expect(getRegistrySize()).toBe(1);

    await onBotReply("C123", "1710000000.001");

    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(getRegistrySize()).toBe(0);
  });

  it("deletes in-progress messages (race condition: bot replies before finish)", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    // Message is registered as in_progress immediately on post — no finish() yet
    expect(getRegistrySize()).toBe(1);

    await onBotReply("C123", "1710000000.001");

    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(getRegistrySize()).toBe(0);
  });

  it("preserves error progress messages", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const errorEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "something broke",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent("C123", "1710000000.001", errorEvent, deps);

    await onBotReply("C123", "1710000000.001");

    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(getRegistrySize()).toBe(1);
  });

  it("is a no-op for unknown threads", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    await onBotReply("C123", "9999999999.999");

    expect(chat(deps).delete).not.toHaveBeenCalled();
  });

  it("deletes multiple progress messages for the same thread", async () => {
    const deps = mockSlackDeps();

    // First session
    chat(deps).postMessage.mockResolvedValueOnce({ ok: true, ts: "msg.001", channel: "C123" });
    await sendTools(deps, 3);
    const done1: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent("C123", "1710000000.001", done1, deps);

    // Second session in same thread
    chat(deps).postMessage.mockResolvedValueOnce({ ok: true, ts: "msg.002", channel: "C123" });
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "start", sessionId: "s2", resumed: false },
      deps,
    );
    await sendTools(deps, 3);
    const done2: ProgressEvent = {
      type: "done",
      sessionId: "s2",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 3000,
    };
    await handleProgressEvent("C123", "1710000000.001", done2, deps);

    expect(getRegistrySize()).toBe(2);

    await onBotReply("C123", "1710000000.001");

    expect(chat(deps).delete).toHaveBeenCalledTimes(2);
    expect(getRegistrySize()).toBe(0);
  });
});
