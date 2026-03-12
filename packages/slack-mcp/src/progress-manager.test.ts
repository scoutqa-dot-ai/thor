import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "@thor/common";
import { handleProgressEvent, pendingCleanups } from "./progress-manager.js";
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
  pendingCleanups.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProgressManager", () => {
  it("does not post a message before the tool call threshold", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 2);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
  });

  it("posts initial message on the 3rd tool call", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1710000000.001",
        text: expect.stringContaining("3 tool calls"),
      }),
    );
  });

  it("shows last 3 tool names in the progress message", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    const text = chat(deps).postMessage.mock.calls[0][0].text as string;
    expect(text).toContain("last: Tool0, Tool1, Tool2");
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

  it("finish with completed status edits to done and registers for cleanup", async () => {
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

    expect(chat(deps).update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg.001",
        text: expect.stringContaining("✅ Done"),
      }),
    );
    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(pendingCleanups.size).toBe(1);
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

describe("pendingCleanups", () => {
  it("onBotReply deletes the progress message", async () => {
    const deps = mockSlackDeps();
    pendingCleanups.register("C123", "1710000000.001", "msg.001", deps);
    expect(pendingCleanups.size).toBe(1);

    await pendingCleanups.onBotReply("C123", "1710000000.001");

    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(pendingCleanups.size).toBe(0);
  });

  it("onBotReply is a no-op for unknown threads", async () => {
    const deps = mockSlackDeps();
    pendingCleanups.register("C123", "1710000000.001", "msg.001", deps);

    await pendingCleanups.onBotReply("C123", "9999999999.999");

    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(pendingCleanups.size).toBe(1);
  });

  it("expires after 60s and keeps the progress message", () => {
    const deps = mockSlackDeps();
    pendingCleanups.register("C123", "1710000000.001", "msg.001", deps);

    vi.advanceTimersByTime(60_000);

    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(pendingCleanups.size).toBe(0);
  });

  it("register replaces existing entry for same thread", () => {
    const deps = mockSlackDeps();
    pendingCleanups.register("C123", "1710000000.001", "msg.001", deps);
    pendingCleanups.register("C123", "1710000000.001", "msg.002", deps);
    expect(pendingCleanups.size).toBe(1);
  });
});
