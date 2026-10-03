import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "./progress-events.js";
import {
  handleProgressEvent,
  getRegistrySize,
  clearRegistry,
  type ProgressTransport,
  type ProgressTarget,
} from "./progress-manager.js";
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

  it("stops and deletes interrupted progress without claiming completion", async () => {
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

    // Interruption is not a successful task, even when a footer already exists.
    expect(chat(deps).update).toHaveBeenCalledOnce();
    const updateCall = chat(deps).update.mock.calls[0][0] as { text: string };
    expect(updateCall.text).not.toContain("Done");
    expect(chat(deps).delete).toHaveBeenCalledOnce();
    expect(reactions(deps).add).not.toHaveBeenCalled();
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

it("renders authenticated Google auth wait instead of Done and stops ticking until a resumed turn", async () => {
  const updates: string[] = [];
  const posts: string[] = [];
  const reactions: string[] = [];
  const target = { key: "auth-wait-recording", sourceTs: "source", transportTarget: {} };
  const recording: ProgressTransport = {
    async post(_target, text) {
      posts.push(text);
      return { ts: "wait-progress" };
    },
    async update(_target, _ts, text) {
      updates.push(text);
    },
    async delete() {},
    async addReaction(_target, _ts, name) {
      reactions.push(name);
    },
  };
  await handleProgressEvent(
    target,
    { type: "start", sessionId: "pi-auth-wait", resumed: false },
    recording,
  );
  for (let index = 0; index < 3; index++)
    await handleProgressEvent(
      target,
      { type: "tool", tool: "bash", status: "completed" },
      recording,
    );
  await handleProgressEvent(
    target,
    {
      type: "done",
      sessionId: "pi-auth-wait",
      resumed: false,
      status: "completed",
      authWait: "google",
      response: "Waiting",
      toolCalls: [],
      durationMs: 1,
    },
    recording,
  );
  expect(updates.at(-1)).toContain("waiting for Google sign-in");
  expect([...posts, ...updates].join("\n")).not.toContain("Done");
  expect(reactions).toEqual([]);
  const count = updates.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(updates).toHaveLength(count);
});

describe("scoped Neo activity lifecycle", () => {
  const scope = { requestId: "request-1", sessionId: "same-session" };
  const done = (fields: Partial<Extract<ProgressEvent, { type: "done" }>> = {}): ProgressEvent => ({
    ...scope,
    type: "done",
    resumed: false,
    status: "completed",
    response: "answer",
    toolCalls: [],
    durationMs: 1,
    ...fields,
  });
  async function begin(
    deps: MockDeps,
    requestId = scope.requestId,
    base = "https://neo.example.test/viewer/path",
  ) {
    const target = { ...progressTarget(deps, "1710000000.002"), assetBaseUrl: base };
    await handleProgressEvent(
      target,
      { ...scope, requestId, type: "start", resumed: false },
      transport,
    );
    return target;
  }

  it("shows long zero-tool thinking once after grace, stops motion at output and reacts to the exact source", async () => {
    const deps = mockSlackDeps();
    const target = await begin(deps);
    await vi.advanceTimersByTimeAsync(1499);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).postMessage.mock.calls[0][0]).toMatchObject({
      text: expect.stringContaining("Neo thinking... 0 tool calls"),
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "image",
              image_url: "https://neo.example.test/neo-thinking-v1.gif",
              alt_text: "Neo activity",
            },
            { type: "mrkdwn", text: expect.stringContaining("Neo thinking") },
          ],
        },
      ],
    });
    for (let index = 0; index < 20; index++)
      await handleProgressEvent(
        target,
        { ...scope, type: "activity", activity: "responding" },
        transport,
      );
    expect(chat(deps).update).toHaveBeenCalledOnce();
    expect(JSON.stringify(chat(deps).update.mock.calls)).toContain("neo-ai-still-v1.png");
    await handleProgressEvent(target, done(), transport);
    expect(reactions(deps).add).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      timestamp: "1710000000.002",
      name: "white_check_mark",
    });
    expect(chat(deps).delete).toHaveBeenCalledOnce();
    const count = chat(deps).update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    await handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "working" },
      transport,
    );
    await handleProgressEvent(target, done(), transport);
    expect(chat(deps).update).toHaveBeenCalledTimes(count);
    expect(reactions(deps).add).toHaveBeenCalledOnce();
  });

  it("does not invent work from heartbeats or retired legacy streams, but accepts the next real start", async () => {
    const deps = mockSlackDeps();
    const target = progressTarget(deps, "1710000000.002");
    await handleProgressEvent(target, { type: "heartbeat" }, transport);
    await vi.advanceTimersByTimeAsync(2000);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    const start = { type: "start" as const, sessionId: "legacy", resumed: false };
    await handleProgressEvent(target, start, transport);
    const completed = {
      type: "done" as const,
      sessionId: "legacy",
      resumed: false,
      status: "completed" as const,
      response: "answer",
      toolCalls: [],
      durationMs: 1,
    };
    await handleProgressEvent(target, completed, transport);
    for (const event of [
      { type: "heartbeat" },
      { type: "tool", sessionId: "legacy", tool: "read", status: "completed" },
      completed,
    ] satisfies ProgressEvent[])
      await handleProgressEvent(target, event, transport);
    await vi.advanceTimersByTimeAsync(2000);
    expect(chat(deps).postMessage).not.toHaveBeenCalled();
    expect(reactions(deps).add).toHaveBeenCalledOnce();
    await handleProgressEvent(target, { ...start, resumed: true }, transport);
    await vi.advanceTimersByTimeAsync(1500);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).postMessage.mock.calls[0][0].text).toContain("Neo thinking... 0 tool calls");
  });

  it.each([0, 1, 2])(
    "completes a fast %i-tool request independently of the footer threshold",
    async (count) => {
      const deps = mockSlackDeps();
      const target = await begin(deps);
      for (let index = 0; index < count; index++) {
        const tool = { ...scope, type: "tool" as const, tool: "read", toolCallId: `call-${index}` };
        await handleProgressEvent(target, { ...tool, status: "running" }, transport);
        await handleProgressEvent(target, { ...tool, status: "completed" }, transport);
      }
      await handleProgressEvent(target, done(), transport);
      expect(chat(deps).postMessage).not.toHaveBeenCalled();
      expect(reactions(deps).add).toHaveBeenCalledOnce();
    },
  );

  it("counts each completed native tool once and switches to working on start without counting it", async () => {
    const deps = mockSlackDeps();
    const target = await begin(deps);
    await vi.advanceTimersByTimeAsync(1500);
    const event = { ...scope, type: "tool" as const, tool: "read", toolCallId: "call-1" };
    await handleProgressEvent(target, { ...event, status: "running" }, transport);
    expect(chat(deps).update.mock.calls.at(-1)?.[0].text).toContain("Neo working... 0 tool calls");
    expect(JSON.stringify(chat(deps).update.mock.calls.at(-1))).toContain("neo-working-v1.gif");
    await handleProgressEvent(target, { ...event, status: "completed" }, transport);
    await handleProgressEvent(target, { ...event, status: "completed" }, transport);
    await handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "thinking" },
      transport,
    );
    expect(chat(deps).update.mock.calls.at(-1)?.[0].text).toContain("Neo thinking... 1 tool calls");
  });

  it.each([
    "",
    "not-a-url",
    "file:///tmp/image",
    "https://user:password@example.test",
    "https://example.test?private=1",
    "https://example.test#private",
  ])("keeps unsafe/blank public base text-only (%s)", async (base) => {
    const deps = mockSlackDeps();
    await begin(deps, scope.requestId, base);
    await vi.advanceTimersByTimeAsync(1500);
    expect(chat(deps).postMessage.mock.calls[0][0].blocks[0].elements).toEqual([
      { type: "mrkdwn", text: expect.stringContaining("Neo thinking") },
    ]);
  });

  it("drains a delayed initial post before completion so it cannot leave an animated orphan", async () => {
    const deps = mockSlackDeps();
    let resolve!: (value: { ts: string }) => void;
    chat(deps).postMessage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const target = await begin(deps);
    vi.advanceTimersByTime(1500);
    const working = handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "working" },
      transport,
    );
    const responding = handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "responding" },
      transport,
    );
    const completion = handleProgressEvent(target, done(), transport);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(reactions(deps).add).not.toHaveBeenCalled();
    resolve({ ts: "late-post" });
    await Promise.all([working, responding, completion]);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).delete).toHaveBeenCalledExactlyOnceWith({ channel: "C123", ts: "late-post" });
    expect(JSON.stringify(chat(deps).update.mock.calls)).not.toContain(".gif");
    expect(reactions(deps).add).toHaveBeenCalledOnce();
    expect(getRegistrySize()).toBe(0);
  });

  it("coalesces overlapping updates while preserving a single posted footer", async () => {
    const deps = mockSlackDeps();
    let resolve!: (value: { ts: string }) => void;
    chat(deps).postMessage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const target = await begin(deps);
    vi.advanceTimersByTime(1500);
    const working = handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "working" },
      transport,
    );
    const responding = handleProgressEvent(
      target,
      { ...scope, type: "activity", activity: "responding" },
      transport,
    );
    resolve({ ts: "coalesced-post" });
    await Promise.all([working, responding]);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).update).toHaveBeenCalledOnce();
    expect(chat(deps).update.mock.calls[0][0].text).toContain("Neo responding");
  });

  it("retires a delayed old post on same-session new start and rejects every stale event", async () => {
    const deps = mockSlackDeps();
    let resolve!: (value: { ts: string }) => void;
    chat(deps).postMessage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const target = await begin(deps);
    vi.advanceTimersByTime(1500);
    const nextTarget = { ...target, sourceTs: "1710000000.003" };
    const next = handleProgressEvent(
      nextTarget,
      { ...scope, requestId: "request-2", type: "start", resumed: true },
      transport,
    );
    for (const event of [
      { ...scope, type: "tool", tool: "stale-tool", status: "completed" },
      { ...scope, type: "activity", activity: "working" },
      { ...scope, type: "memory", action: "write", path: "/stale", source: "tool" },
      {
        ...scope,
        type: "context",
        providerID: "stale",
        modelID: "stale",
        tokens: 10,
        limit: 100,
        usagePercent: 10,
      },
      { ...scope, type: "error", error: "stale-error" },
      done(),
      { ...scope, type: "start", resumed: false },
    ] satisfies ProgressEvent[])
      await handleProgressEvent(target, event, transport);
    resolve({ ts: "old-footer" });
    await next;
    expect(chat(deps).delete).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      ts: "old-footer",
    });
    expect(reactions(deps).add).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(chat(deps).postMessage).toHaveBeenCalledTimes(2);
    expect(chat(deps).postMessage.mock.calls[1][0].text).toContain("0 tool calls");
    await handleProgressEvent(nextTarget, done({ requestId: "request-2" }), transport);
    expect(reactions(deps).add).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      timestamp: "1710000000.003",
      name: "white_check_mark",
    });
  });

  it("also drains an in-flight short auth-wait post when superseded", async () => {
    const deps = mockSlackDeps();
    let resolve!: (value: { ts: string }) => void;
    chat(deps).postMessage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const target = await begin(deps);
    const waiting = handleProgressEvent(target, done({ authWait: "google" }), transport);
    await Promise.resolve();
    const next = handleProgressEvent(
      target,
      { ...scope, requestId: "request-2", type: "start", resumed: true },
      transport,
    );
    resolve({ ts: "wait-footer" });
    await Promise.all([waiting, next]);
    expect(chat(deps).delete).toHaveBeenCalledOnce();
    expect(getRegistrySize()).toBe(0);
    expect(reactions(deps).add).not.toHaveBeenCalled();
  });

  it("keeps a short OAuth wait visible and static, with no completion check or ticks", async () => {
    const deps = mockSlackDeps();
    const target = await begin(deps);
    await handleProgressEvent(target, done({ authWait: "google" }), transport);
    expect(chat(deps).postMessage.mock.calls[0][0].text).toContain("waiting for Google sign-in");
    expect(JSON.stringify(chat(deps).postMessage.mock.calls)).toContain("neo-ai-still-v1.png");
    await vi.advanceTimersByTimeAsync(120000);
    expect(chat(deps).postMessage).toHaveBeenCalledOnce();
    expect(chat(deps).update).not.toHaveBeenCalled();
    expect(reactions(deps).add).not.toHaveBeenCalled();
  });

  it("transport errors do not fail task completion and failed deletes leave only static progress", async () => {
    const deps = mockSlackDeps();
    const target = await begin(deps);
    chat(deps).postMessage.mockRejectedValueOnce(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(10000);
    expect(chat(deps).postMessage).toHaveBeenCalledTimes(2);
    chat(deps).delete.mockRejectedValue(new Error("unavailable"));
    reactions(deps).add.mockRejectedValue(new Error("unavailable"));
    await expect(handleProgressEvent(target, done(), transport)).resolves.toBeUndefined();
    expect(JSON.stringify(chat(deps).update.mock.calls.at(-1))).toContain("neo-ai-still-v1.png");
    expect(chat(deps).update.mock.calls.at(-1)?.[0].text).toContain("✅ Done");
    expect(getRegistrySize()).toBe(1);
  });
});

it.each(["waiting", "error"] as const)(
  "tries to remove motion when a %s static update is unavailable",
  async (status) => {
    const deps = mockSlackDeps();
    const target = progressTarget(deps, "1710000000.002");
    await sendTools(deps, 3);
    chat(deps).update.mockRejectedValue(new Error("unavailable"));
    await handleProgressEvent(
      target,
      {
        type: "done",
        sessionId: "legacy",
        resumed: false,
        status: status === "waiting" ? "completed" : "error",
        authWait: status === "waiting" ? "google" : undefined,
        error: status === "error" ? "task failed" : undefined,
        response: "",
        toolCalls: [],
        durationMs: 1,
      },
      transport,
    );
    expect(chat(deps).delete).toHaveBeenCalledOnce();
    expect(reactions(deps).add).not.toHaveBeenCalled();
  },
);
