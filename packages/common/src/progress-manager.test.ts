import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "./progress-events.ts";
import {
  handleProgressEvent,
  getRegistrySize,
  clearRegistry,
  type ProgressTransport,
  type ProgressTarget,
} from "./progress-manager.ts";
type SlackDeps = { client: any };

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
    },
  } satisfies SlackDeps;
}

type MockDeps = ReturnType<typeof mockSlackDeps>;

function progressTarget(
  deps: MockDeps,
  sourceTs = "",
  channel = "C123",
  threadTs = "1710000000.001",
): ProgressTarget<MockDeps> {
  return { key: `${channel}:${threadTs}`, sourceTs, transportTarget: deps };
}

const transport: ProgressTransport<MockDeps> = {
  async post(deps, text, blocks) {
    return deps.client.chat.postMessage({
      channel: "C123",
      text,
      thread_ts: "1710000000.001",
      ...(blocks ? { blocks } : {}),
    });
  },
  async update(deps, ts, text, blocks) {
    await deps.client.chat.update({ channel: "C123", ts, text, ...(blocks ? { blocks } : {}) });
  },
  async delete(deps, ts) {
    await deps.client.chat.delete({ channel: "C123", ts });
  },
  async addReaction(deps, timestamp, name) {
    await deps.client.reactions.add({ channel: "C123", timestamp, name });
  },
};

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

function reactions(deps: MockDeps) {
  const c = deps.client as unknown as {
    reactions: {
      add: ReturnType<typeof vi.fn>;
    };
  };
  return c.reactions;
}

async function sendTools(
  deps: MockDeps,
  count: number,
  channel = "C123",
  threadTs = "1710000000.001",
  sourceTs = "",
) {
  for (let i = 0; i < count; i++) {
    await handleProgressEvent(
      progressTarget(deps, sourceTs, channel, threadTs),
      { type: "tool", tool: `Tool${i}`, status: "completed" },
      transport,
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

  it("posts initial message on the 3rd tool call", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1710000000.001",
      }),
    );
  });

  it("includes memory and delegated agents in progress context", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/my-repo/README.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "research-agent",
      },
      transport,
    );
    await sendTools(deps, 3);

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("3 tool calls");
    expect(postCall.text).toContain("memory: README.md");
    expect(postCall.text).toContain("agents: research-agent");
  });

  it("renders context only at or above 50 percent and removes it on later lower usage", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 90_000,
        limit: 200_000,
        usagePercent: 45,
      },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).not.toContain("context:");

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 126_000,
        limit: 200_000,
        usagePercent: 63,
      },
      transport,
    );

    const highUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(highUpdate.text).toContain("context: 63% (126.0K / 200.0K tokens)");

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 80_000,
        limit: 200_000,
        usagePercent: 40,
      },
      transport,
    );

    const lowUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(lowUpdate.text).not.toContain("context:");
  });

  it("renders context at the normalized 50 percent boundary", async () => {
    const deps = mockSlackDeps();

    await sendTools(deps, 3);
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 99_999,
        limit: 200_000,
        usagePercent: 50,
      },
      transport,
    );

    const update = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(update.text).toContain("context: 50% (99.9K / 200.0K tokens)");
  });

  it("preserves a visible context line across bogus zero context updates", async () => {
    const deps = mockSlackDeps();

    await sendTools(deps, 3);
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 126_000,
        limit: 200_000,
        usagePercent: 63,
      },
      transport,
    );

    const updateCountBeforeZero = chat(deps).update.mock.calls.length;
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 0,
        limit: 200_000,
        usagePercent: 0,
      },
      transport,
    );

    expect(chat(deps).update.mock.calls.length).toBe(updateCountBeforeZero);

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "coding-agent",
      },
      transport,
    );

    const latestUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(latestUpdate.text).toContain("context: 63% (126.0K / 200.0K tokens)");
    expect(latestUpdate.text).toContain("agents: coding-agent");
  });

  it("does not let context events satisfy the tool threshold", async () => {
    const deps = mockSlackDeps();

    for (let i = 0; i < 3; i++) {
      await handleProgressEvent(
        progressTarget(deps),
        {
          type: "context",
          providerID: "openai",
          modelID: "gpt-5.5",
          tokens: 150_000 + i,
          limit: 200_000,
          usagePercent: 75,
        },
        transport,
      );
    }

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    await sendTools(deps, 2);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
  });

  it("does not flush for repeated sub-50 context updates with no rendered change", async () => {
    const deps = mockSlackDeps();

    await sendTools(deps, 3);
    const updateCountBefore = chat(deps).update.mock.calls.length;

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 90_000,
        limit: 200_000,
        usagePercent: 45,
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "context",
        providerID: "openai",
        modelID: "gpt-5.5",
        tokens: 80_000,
        limit: 200_000,
        usagePercent: 40,
      },
      transport,
    );

    expect(chat(deps).update.mock.calls.length).toBe(updateCountBefore);
  });

  it("renders delegate context from task-derived delegate events", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "research-agent",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "research-agent",
      },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("agents: research-agent x2");
  });

  it("collapses consecutive duplicate agents using run semantics", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      { type: "delegate", agent: "research-agent" },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      { type: "delegate", agent: "research-agent" },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      { type: "delegate", agent: "coding-agent" },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      { type: "delegate", agent: "research-agent" },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("agents: research-agent x2, coding-agent, research-agent");
  });

  it("renders the latest five recent agent groups like tools", async () => {
    const deps = mockSlackDeps();

    for (const agent of ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"]) {
      await handleProgressEvent(progressTarget(deps), { type: "delegate", agent }, transport);
    }
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("agents: agent-b, agent-c, agent-d, agent-e, agent-f");
    expect(postCall.text).not.toContain("agents: agent-a");
  });

  it("shows compact memory file labels when fewer than 3 distinct files", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/service-a/notes.md",
        source: "bootstrap",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/service-b/README.md",
        source: "tool",
      },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("memory: notes.md, README.md");
    expect(postCall.text).not.toContain("(boot)");
    expect(postCall.text).not.toContain("read ");
    expect(postCall.text).not.toContain("write ");
  });

  it("summarizes memory activity counts when 3+ distinct files are present", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/a.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/b.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/c.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/a.md",
        source: "tool",
      },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("memory: read x3, write x1");
  });

  it("excludes README.md reads from memory tracking", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/my-repo/README.md",
        source: "bootstrap",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/my-repo/notes.md",
        source: "tool",
      },
      transport,
    );
    await sendTools(deps, 3);

    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("memory: notes.md");
    expect(postCall.text).not.toContain("README.md");
  });

  it("does not count memory/delegate events toward tool threshold", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 2);

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "coding-agent",
      },
      transport,
    );

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
  });

  it("updates immediately when memory/delegate context arrives after threshold is reached", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).update).not.toHaveBeenCalled();

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
      transport,
    );
    expect(chat(deps).update).toHaveBeenCalledOnce();
    expect((chat(deps).update.mock.calls[0][0] as { text: string }).text).toContain(
      "memory: README.md",
    );

    await handleProgressEvent(
      progressTarget(deps),
      {
        type: "delegate",
        agent: "coding-agent",
      },
      transport,
    );
    expect(chat(deps).update).toHaveBeenCalledTimes(2);
    expect((chat(deps).update.mock.calls[1][0] as { text: string }).text).toContain(
      "agents: coding-agent",
    );
  });

  it("throttles updates to 10s intervals", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();

    // 4th call immediately — should be throttled
    await handleProgressEvent(
      progressTarget(deps),
      { type: "tool", tool: "Write", status: "completed" },
      transport,
    );
    expect(chat(deps).update).not.toHaveBeenCalled();

    // Advance 10s, next call should trigger update
    vi.advanceTimersByTime(10_000);
    await handleProgressEvent(
      progressTarget(deps),
      { type: "tool", tool: "Bash", status: "completed" },
      transport,
    );
    expect(chat(deps).update).toHaveBeenCalledOnce();
  });

  it("ticks the elapsed timer even when no events arrive", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).update).not.toHaveBeenCalled();

    // No events for 30s — heartbeat ticks at 10s under 10m elapsed, so we
    // expect at least a couple of refresh updates.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (chat(deps).update as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("backs off the heartbeat cadence as the session ages", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();

    const updateMock = chat(deps).update as ReturnType<typeof vi.fn>;

    // <10m elapsed → 10s cadence. ~3 ticks in 30s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Jump past 10m total. Now cadence is 30s.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const after10m = updateMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const ticksAt30s = updateMock.mock.calls.length - after10m;
    // 2m at 30s cadence ≈ 4 ticks; should be far fewer than the 12 we'd see at 10s.
    expect(ticksAt30s).toBeLessThanOrEqual(6);
    expect(ticksAt30s).toBeGreaterThanOrEqual(2);

    // Jump well past 60m so the next scheduled tick uses the 60s cadence.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const baseline = updateMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const ticksAt60s = updateMock.mock.calls.length - baseline;
    // 5m at 60s cadence ≈ 5 ticks; should be far fewer than the 10 we'd see at 30s.
    expect(ticksAt60s).toBeGreaterThanOrEqual(2);
    expect(ticksAt60s).toBeLessThanOrEqual(7);
  });

  it("finish with completed status updates then deletes the progress message", async () => {
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
    await handleProgressEvent(progressTarget(deps), doneEvent, transport);

    // Updates message to "Done", then onSessionEnd deletes it
    expect(chat(deps).update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg.001",
      }),
    );
    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(getRegistrySize()).toBe(0);
  });

  it("treats abort errors as completed (updates to Done)", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3); // cross threshold, message posted

    const abortEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "Aborted",
      response: "",
      toolCalls: [],
      durationMs: 500,
    };
    await handleProgressEvent(progressTarget(deps, ""), abortEvent, transport);

    // Should update to "Done" — not show an error
    expect(chat(deps).update).toHaveBeenCalledOnce();
    const updateCall = chat(deps).update.mock.calls[0][0] as { text: string };
    expect(updateCall.text).toContain("Done");
    expect(updateCall.text).not.toContain("Failed");
  });

  it("suppresses abort errors even below threshold (no Slack message at all)", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 1); // below threshold

    const abortEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "Aborted",
      response: "",
      toolCalls: [],
      durationMs: 200,
    };
    await handleProgressEvent(progressTarget(deps, ""), abortEvent, transport);

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    expect(chat(deps).update).not.toHaveBeenCalled();
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
    await handleProgressEvent(progressTarget(deps, ""), doneEvent, transport);

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    expect(chat(deps).update).not.toHaveBeenCalled();
  });

  it("adds x reaction instead of posting a first-time failure message", async () => {
    const deps = mockSlackDeps();
    await handleProgressEvent(
      progressTarget(deps, "1710000000.123"),
      { type: "start", sessionId: "s1", resumed: false },
      transport,
    );
    await sendTools(deps, 1);

    const errorEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "provider unavailable",
      response: "",
      toolCalls: [],
      durationMs: 100,
    };
    await handleProgressEvent(progressTarget(deps, "1710000000.123"), errorEvent, transport);

    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    expect(chat(deps).update).not.toHaveBeenCalled();
    expect(reactions(deps).add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.123",
      name: "x",
    });
  });
});

describe("onSessionEnd (via handleProgressEvent done)", () => {
  it("deletes completed progress messages automatically", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(getRegistrySize()).toBe(1);

    const doneEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "completed",
      response: "",
      toolCalls: [],
      durationMs: 5000,
    };
    await handleProgressEvent(progressTarget(deps, ""), doneEvent, transport);

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
    await handleProgressEvent(progressTarget(deps, ""), errorEvent, transport);

    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(getRegistrySize()).toBe(1);
  });

  it("cleans up sequential sessions in the same thread", async () => {
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
    await handleProgressEvent(progressTarget(deps, ""), done1, transport);

    // Session 1's message cleaned up immediately
    expect(chat(deps).delete).toHaveBeenCalledWith({ channel: "C123", ts: "msg.001" });
    expect(getRegistrySize()).toBe(0);

    // Second session in same thread
    chat(deps).postMessage.mockResolvedValueOnce({ ok: true, ts: "msg.002", channel: "C123" });
    await handleProgressEvent(
      progressTarget(deps, ""),
      { type: "start", sessionId: "s2", resumed: false },
      transport,
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
    await handleProgressEvent(progressTarget(deps, ""), done2, transport);

    // Session 2's message also cleaned up
    expect(chat(deps).delete).toHaveBeenCalledWith({ channel: "C123", ts: "msg.002" });
    expect(chat(deps).delete).toHaveBeenCalledTimes(2);
    expect(getRegistrySize()).toBe(0);
  });
});
