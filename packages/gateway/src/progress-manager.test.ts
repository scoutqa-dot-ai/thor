import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "@thor/common";
import {
  handleProgressEvent,
  onBotReply,
  getRegistrySize,
  clearRegistry,
} from "./progress-manager.js";
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

describe("onBotReply", () => {
  it("skips deletion when session is still active", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);
    expect(getRegistrySize()).toBe(1);

    await onBotReply("C123", "1710000000.001");

    expect(callsTo(deps, "chat.delete")).toHaveLength(0);
    expect(getRegistrySize()).toBe(1);
  });

  it("is a no-op for unknown threads", async () => {
    const deps = mockSlackDeps();
    await sendTools(deps, 3);

    await onBotReply("C123", "9999999999.999");

    expect(callsTo(deps, "chat.delete")).toHaveLength(0);
  });
});
