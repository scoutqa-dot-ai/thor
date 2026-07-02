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

  it("orphan eviction past max age deletes the progress message and prunes the registry", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(getRegistrySize()).toBe(1);

    // No terminal `done` ever arrives. Advance past the 6h backstop so the
    // ticker self-evicts; the orphan path must run the same cleanup as done,
    // or the registry entry and the Slack message leak forever.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 60_000);

    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(getRegistrySize()).toBe(0);
  });

  it("finish with completed status deletes the progress message without a transient edit", async () => {
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

    // No "Done" edit — cleanup path deletes the message directly
    expect(chat(deps).update).not.toHaveBeenCalled();
    expect(chat(deps).delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg.001",
    });
    expect(getRegistrySize()).toBe(0);
  });

  it("keeps a memory-write audit message on completion instead of deleting it", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/service-a/notes.md",
        source: "tool",
      },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/service-b/plan.md",
        source: "tool",
      },
      transport,
    );
    // A read must not appear in the write audit.
    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/service-a/other.md",
        source: "tool",
      },
      transport,
    );
    await sendTools(deps, 3); // cross threshold so a live message exists

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

    // The live message is finalized into an audit list, not deleted.
    expect(chat(deps).delete).not.toHaveBeenCalled();
    const finalUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(finalUpdate.text).toContain("Memory updated — 2 files written");
    expect(finalUpdate.text).toContain("service-a/notes.md");
    expect(finalUpdate.text).toContain("service-b/plan.md");
    expect(finalUpdate.text).not.toContain("other.md");
    // Retained messages are dropped from the registry so it cannot grow.
    expect(getRegistrySize()).toBe(0);
  });

  it("posts a memory-write audit even for a short run below the tool threshold", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/service-a/notes.md",
        source: "tool",
      },
      transport,
    );
    await sendTools(deps, 1); // below threshold — no live message posted yet
    expect(chat(deps).postMessage).not.toHaveBeenCalled();

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

    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    const postCall = chat(deps).postMessage.mock.calls[0][0] as { text: string };
    expect(postCall.text).toContain("Memory updated — 1 file written");
    expect(postCall.text).toContain("service-a/notes.md");
    expect(chat(deps).delete).not.toHaveBeenCalled();
  });

  it("keeps a recovered-error audit message when a run completes after errors", async () => {
    const deps = mockSlackDeps();

    // Two errors mid-run (one seen twice), then the run recovers and completes.
    await handleProgressEvent(
      progressTarget(deps, ""),
      { type: "session_error", message: "rate limited" },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps, ""),
      { type: "session_error", message: "rate limited" },
      transport,
    );
    await handleProgressEvent(
      progressTarget(deps, ""),
      { type: "session_error", message: "connection reset" },
      transport,
    );

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

    const postCall = chat(deps).postMessage.mock.calls.at(-1)?.[0] as { text: string };
    expect(postCall.text).toContain("Recovered from 3 errors during the run");
    expect(postCall.text).toContain("rate limited x2");
    expect(postCall.text).toContain("connection reset");
    expect(chat(deps).delete).not.toHaveBeenCalled();
  });

  it("renders errors as a failure (not 'recovered') when the run itself fails", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    await handleProgressEvent(
      progressTarget(deps, ""),
      { type: "session_error", message: "provider down" },
      transport,
    );

    const errorEvent: ProgressEvent = {
      type: "done",
      sessionId: "s1",
      resumed: false,
      status: "error",
      error: "provider down",
      response: "",
      toolCalls: [],
      durationMs: 1000,
    };
    await handleProgressEvent(progressTarget(deps, ""), errorEvent, transport);

    // Same error signal, framed as a failure headline (not "recovered"). The
    // message is retained (not deleted) via registry removal.
    const finalUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(finalUpdate.text).toContain("❌ Failed after 3 tool calls");
    expect(finalUpdate.text).toContain("• provider down");
    expect(finalUpdate.text).not.toContain("Recovered from");
    expect(chat(deps).delete).not.toHaveBeenCalled();
  });

  it("treats abort errors as completed (no error message, deletes message)", async () => {
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

    // Abort-as-completed: no error shown, message deleted silently
    expect(chat(deps).update).not.toHaveBeenCalled();
    expect(chat(deps).delete).toHaveBeenCalledOnce();
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
    await sendTools(deps, 1, "C123", "1710000000.001", "1710000000.123");

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
  it("drops registry entries when Slack cleanup races message_not_found", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    chat(deps).delete.mockRejectedValueOnce(new Error("slack error: message_not_found"));

    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "done",
        sessionId: "s1",
        resumed: false,
        status: "completed",
        response: "",
        toolCalls: [],
        durationMs: 1000,
      },
      transport,
    );

    expect(getRegistrySize()).toBe(0);
  });

  it("retains registry entries for retryable Slack delete failures", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    chat(deps).delete.mockRejectedValueOnce(new Error("slack error: ratelimited"));

    await handleProgressEvent(
      progressTarget(deps, ""),
      {
        type: "done",
        sessionId: "s1",
        resumed: false,
        status: "completed",
        response: "",
        toolCalls: [],
        durationMs: 1000,
      },
      transport,
    );

    expect(getRegistrySize()).toBe(1);
  });

  it("preserves error progress messages (retained, not deleted)", async () => {
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

    // Failure audit is retained: the message is updated in place and dropped
    // from the cleanup registry (removal — not a status flag — is what keeps it
    // both visible in Slack and out of the registry).
    const finalUpdate = chat(deps).update.mock.calls.at(-1)?.[0] as { text: string };
    expect(finalUpdate.text).toContain("❌ Failed after 3 tool calls");
    expect(finalUpdate.text).toContain("• something broke");
    expect(chat(deps).delete).not.toHaveBeenCalled();
    expect(getRegistrySize()).toBe(0);
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

    // Second session in same thread — session created on first tool event
    chat(deps).postMessage.mockResolvedValueOnce({ ok: true, ts: "msg.002", channel: "C123" });
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
