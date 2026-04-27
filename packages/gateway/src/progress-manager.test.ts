import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "@thor/common";
import { handleProgressEvent, getRegistrySize, clearRegistry } from "./progress-manager.js";
import type { SlackDeps } from "./slack-api.js";

function mockSlackDeps() {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/chat.postMessage")) {
      return new Response(JSON.stringify({ ok: true, ts: "msg.001", channel: "C123" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  return {
    botToken: "xoxb-test",
    fetchImpl,
    slackApiBaseUrl: "https://slack.com/api",
  } satisfies SlackDeps;
}

type MockDeps = ReturnType<typeof mockSlackDeps>;

function callsTo(deps: MockDeps, endpoint: string) {
  return deps.fetchImpl.mock.calls.filter(
    (c) => String(c[0]) === `https://slack.com/api/${endpoint}`,
  );
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
      channel,
      threadTs,
      { type: "tool", tool: `Tool${i}`, status: "completed" },
      deps,
      sourceTs,
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
    expect(callsTo(deps, "chat.postMessage")).toHaveLength(0);
  });

  it("posts initial message on the 3rd tool call", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(1);
    const postBody = JSON.parse(String(callsTo(deps, "chat.postMessage")[0][1]?.body));
    expect(postBody.channel).toBe("C123");
    expect(postBody.thread_ts).toBe("1710000000.001");
  });

  it("includes memory and delegated agents in progress context", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/my-repo/README.md",
        source: "tool",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "delegate",
        agent: "research-agent",
        description: "investigate flaky tests",
      },
      deps,
      "",
    );
    await sendTools(deps, 3);

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(1);
    const postBody = JSON.parse(String(callsTo(deps, "chat.postMessage")[0][1]?.body));
    expect(postBody.text).toContain("3 tool calls");
    expect(postBody.text).toContain("memory: README.md");
    expect(postBody.text).toContain("agents: research-agent");
    expect(postBody.text).not.toContain("investigate flaky tests");
  });

  it("collapses consecutive duplicate agents using run semantics", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "delegate", agent: "research-agent", description: "first" },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "delegate", agent: "research-agent", description: "second" },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "delegate", agent: "coding-agent" },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "delegate", agent: "research-agent" },
      deps,
      "",
    );
    await sendTools(deps, 3);

    const postBody = JSON.parse(String(callsTo(deps, "chat.postMessage")[0][1]?.body));
    expect(postBody.text).toContain("agents: research-agent x2, coding-agent, research-agent");
  });

  it("shows compact memory file labels when fewer than 3 distinct files are present", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/service-a/notes.md",
        source: "bootstrap",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/service-b/README.md",
        source: "tool",
      },
      deps,
      "",
    );
    await sendTools(deps, 3);

    const postBody = JSON.parse(String(callsTo(deps, "chat.postMessage")[0][1]?.body));
    expect(postBody.text).toContain("memory: notes.md, README.md");
    expect(postBody.text).not.toContain("(boot)");
    expect(postBody.text).not.toContain("read ");
    expect(postBody.text).not.toContain("write ");
  });

  it("summarizes memory activity counts when 3+ distinct files are present", async () => {
    const deps = mockSlackDeps();

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/a.md",
        source: "tool",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/b.md",
        source: "tool",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/c.md",
        source: "tool",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "read",
        path: "/workspace/memory/a.md",
        source: "tool",
      },
      deps,
      "",
    );
    await sendTools(deps, 3);

    const postBody = JSON.parse(String(callsTo(deps, "chat.postMessage")[0][1]?.body));
    expect(postBody.text).toContain("memory: read x3, write x1");
  });

  it("does not count memory/delegate events toward tool threshold", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 2);

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
      deps,
      "",
    );
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "delegate",
        agent: "coding-agent",
      },
      deps,
      "",
    );

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(0);
  });

  it("updates immediately when memory/delegate context arrives after threshold is reached", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(1);
    expect(callsTo(deps, "chat.update")).toHaveLength(0);

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "memory",
        action: "write",
        path: "/workspace/memory/README.md",
        source: "tool",
      },
      deps,
      "",
    );
    expect(callsTo(deps, "chat.update")).toHaveLength(1);
    let updateBody = JSON.parse(String(callsTo(deps, "chat.update")[0][1]?.body));
    expect(updateBody.text).toContain("memory: README.md");

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      {
        type: "delegate",
        agent: "coding-agent",
      },
      deps,
      "",
    );
    expect(callsTo(deps, "chat.update")).toHaveLength(2);
    updateBody = JSON.parse(String(callsTo(deps, "chat.update")[1][1]?.body));
    expect(updateBody.text).toContain("agents: coding-agent");
  });

  it("throttles updates to 10s intervals", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(callsTo(deps, "chat.postMessage")).toHaveLength(1);

    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "tool", tool: "Write", status: "completed" },
      deps,
      "",
    );
    expect(callsTo(deps, "chat.update")).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "tool", tool: "Bash", status: "completed" },
      deps,
      "",
    );
    expect(callsTo(deps, "chat.update")).toHaveLength(1);
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
    await handleProgressEvent("C123", "1710000000.001", doneEvent, deps, "");

    expect(callsTo(deps, "chat.update")).toHaveLength(1);
    expect(callsTo(deps, "chat.delete")).toHaveLength(1);
    expect(getRegistrySize()).toBe(0);
  });

  it("treats abort errors as completed (updates to Done)", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

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
    await handleProgressEvent("C123", "1710000000.001", abortEvent, deps, "");

    const updateBody = JSON.parse(String(callsTo(deps, "chat.update")[0][1]?.body));
    expect(updateBody.text).toContain("Done");
    expect(updateBody.text).not.toContain("Failed");
  });

  it("suppresses abort errors even below threshold", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 1);

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
    await handleProgressEvent("C123", "1710000000.001", abortEvent, deps, "");

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(0);
    expect(callsTo(deps, "chat.update")).toHaveLength(0);
  });

  it("produces no Slack messages for short completed runs below threshold", async () => {
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
    await handleProgressEvent("C123", "1710000000.001", doneEvent, deps, "");

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(0);
    expect(callsTo(deps, "chat.update")).toHaveLength(0);
  });

  it("adds x reaction instead of posting a first-time failure message", async () => {
    const deps = mockSlackDeps();
    await handleProgressEvent(
      "C123",
      "1710000000.001",
      { type: "start", sessionId: "s1", resumed: false },
      deps,
      "1710000000.123",
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
    await handleProgressEvent("C123", "1710000000.001", errorEvent, deps, "1710000000.123");

    expect(callsTo(deps, "chat.postMessage")).toHaveLength(0);
    expect(callsTo(deps, "chat.update")).toHaveLength(0);
    const reactionBody = JSON.parse(String(callsTo(deps, "reactions.add")[0][1]?.body));
    expect(reactionBody).toEqual({ channel: "C123", timestamp: "1710000000.123", name: "x" });
  });
});
