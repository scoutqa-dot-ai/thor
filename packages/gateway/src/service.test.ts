import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerDeps } from "./service.js";
import type { SlackDeps } from "./slack-api.js";

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function ndjsonResponse(lines: string[], status = 200): Response {
  return new Response(ndjsonStream(lines), {
    status,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

describe("resolveApproval", () => {
  it("posts resolve requests to remote-cli with the secret header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ stdout: "ok", stderr: "", exitCode: 0 }));

    const { resolveApproval } = await import("./service.js");
    const result = await resolveApproval(
      "act-1",
      "approved",
      "U123",
      "http://remote-cli:3004",
      "resolve-secret",
      fetchImpl,
      "ship it",
    );

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledWith("http://remote-cli:3004/exec/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-thor-resolve-secret": "resolve-secret",
      },
      body: JSON.stringify({
        args: ["resolve", "act-1", "approved", "U123", "ship it"],
      }),
    });
  });

  it("returns undefined when remote-cli reports a command failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ stdout: "", stderr: "Unknown subcommand: resolve\n", exitCode: 1 }),
      );

    const { resolveApproval } = await import("./service.js");
    const result = await resolveApproval(
      "act-1",
      "approved",
      "U123",
      "http://remote-cli:3004",
      "wrong-secret",
      fetchImpl,
    );

    expect(result).toBeUndefined();
  });
});

describe("consumeNdjsonStream (via triggerRunnerSlack)", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let mockSlackFetch: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackDeps: SlackDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    mockSlackFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, ts: "msg.001", channel: "C123" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackDeps = {
      botToken: "xoxb-test",
      fetchImpl: mockSlackFetch,
      slackApiBaseUrl: "https://slack.com/api",
    };

    vi.mock("@thor/common", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, resolveRepoDirectory: () => "/workspace/repos/my-repo" };
    });
  });

  const slackEvent = {
    channel: "C123",
    ts: "1710000000.001",
    thread_ts: "1710000000.001",
    text: "hello",
    user: "U1",
    type: "message",
  } as const;
  const channelRepos = new Map([["C123", "my-repo"]]);

  it("posts, updates, and deletes progress messages via Slack Web API", async () => {
    const lines = [
      JSON.stringify({ type: "start", sessionId: "s1", resumed: false }),
      JSON.stringify({ type: "tool", tool: "bash", status: "completed" }),
      JSON.stringify({ type: "tool", tool: "read", status: "completed" }),
      JSON.stringify({ type: "tool", tool: "write", status: "completed" }),
      JSON.stringify({
        type: "done",
        sessionId: "s1",
        resumed: false,
        status: "completed",
        response: "ok",
        toolCalls: [],
        durationMs: 100,
      }),
    ];
    mockRunnerFetch.mockResolvedValue(ndjsonResponse(lines));

    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );
    expect(result.busy).toBe(false);

    await new Promise((r) => setTimeout(r, 50));

    const slackUrls = mockSlackFetch.mock.calls.map((c: [string]) => c[0]);
    expect(slackUrls).toContain("https://slack.com/api/chat.postMessage");
    expect(slackUrls).toContain("https://slack.com/api/chat.update");
    expect(slackUrls).toContain("https://slack.com/api/chat.delete");
  });

  it("posts approval_required events with v2 button payload format", async () => {
    const lines = [
      JSON.stringify({
        type: "approval_required",
        actionId: "act-1",
        tool: "merge_pull_request",
        args: { pr: 42 },
        proxyName: "github",
      }),
    ];
    mockRunnerFetch.mockResolvedValue(ndjsonResponse(lines));

    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const approvalCall = mockSlackFetch.mock.calls.find(
      (c: [string]) => c[0] === "https://slack.com/api/chat.postMessage",
    );
    expect(approvalCall).toBeDefined();
    const body = JSON.parse((approvalCall?.[1] as { body: string }).body);
    const approveButton = body.blocks[3].elements.find(
      (el: { action_id: string }) => el.action_id === "approval_approve",
    );
    expect(approveButton.value).toBe("v2:act-1:github");
  });

  it("skips invalid NDJSON lines without crashing", async () => {
    const lines = [
      "not valid json",
      JSON.stringify({ type: "tool", tool: "bash", status: "completed" }),
      JSON.stringify({ unknown: "schema" }),
      "",
    ];
    mockRunnerFetch.mockResolvedValue(ndjsonResponse(lines));

    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );
    expect(result.busy).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSlackFetch).not.toHaveBeenCalled();
  });

  it("adds an x reaction on early errors below the progress threshold", async () => {
    const lines = [
      JSON.stringify({ type: "start", sessionId: "s1", resumed: false }),
      JSON.stringify({ type: "tool", tool: "bash", status: "completed" }),
      JSON.stringify({
        type: "done",
        sessionId: "s1",
        resumed: false,
        status: "error",
        error: "provider unavailable",
        response: "",
        toolCalls: [],
        durationMs: 100,
      }),
    ];
    mockRunnerFetch.mockResolvedValue(ndjsonResponse(lines));

    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const reactionCall = mockSlackFetch.mock.calls.find(
      (c: [string]) => c[0] === "https://slack.com/api/reactions.add",
    );
    expect(reactionCall).toBeDefined();
    const body = JSON.parse((reactionCall?.[1] as { body: string }).body);
    expect(body).toEqual({ channel: "C123", timestamp: "1710000000.001", name: "x" });
  });

  it("handles chunked delivery across newline boundaries", async () => {
    const line1 = JSON.stringify({ type: "tool", tool: "read", status: "completed" });
    const line2 = JSON.stringify({ type: "tool", tool: "write", status: "completed" });
    const line3 = JSON.stringify({ type: "tool", tool: "bash", status: "completed" });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const full = line1 + "\n" + line2 + "\n" + line3 + "\n";
        const mid = Math.floor(full.length / 2);
        controller.enqueue(enc.encode(full.slice(0, mid)));
        controller.enqueue(enc.encode(full.slice(mid)));
        controller.close();
      },
    });
    mockRunnerFetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );

    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const postCalls = mockSlackFetch.mock.calls.filter(
      (c: [string]) => c[0] === "https://slack.com/api/chat.postMessage",
    );
    expect(postCalls.length).toBe(1);
  });
});

describe("triggerRunnerSlack edge cases", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackDeps: SlackDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackDeps = {
      botToken: "xoxb-test",
      fetchImpl: vi.fn(),
      slackApiBaseUrl: "https://slack.com/api",
    };
  });

  const slackEvent = {
    channel: "C123",
    ts: "1710000000.001",
    thread_ts: "1710000000.001",
    text: "hello",
    user: "U1",
    type: "message",
  } as const;

  it("returns early for empty events", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack([], "key1", runnerDeps, slackDeps);
    expect(result.busy).toBe(false);
    expect(mockRunnerFetch).not.toHaveBeenCalled();
  });

  it("rejects when channel has no repo mapping", async () => {
    const onRejected = vi.fn();
    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      new Map(),
      onRejected,
    );
    expect(result.busy).toBe(false);
    expect(onRejected).toHaveBeenCalledWith(expect.stringContaining("no repo mapping"));
    expect(mockRunnerFetch).not.toHaveBeenCalled();
  });

  it("returns busy when runner responds with busy JSON", async () => {
    mockRunnerFetch.mockResolvedValue(jsonResponse({ busy: true }));

    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      new Map([["C123", "my-repo"]]),
    );
    expect(result.busy).toBe(true);
  });

  it("throws when runner returns non-ok", async () => {
    mockRunnerFetch.mockResolvedValue(textResponse("bad request", 400));

    const { triggerRunnerSlack } = await import("./service.js");
    await expect(
      triggerRunnerSlack(
        [slackEvent],
        "key1",
        runnerDeps,
        slackDeps,
        false,
        undefined,
        new Map([["C123", "repo"]]),
      ),
    ).rejects.toThrow("Runner returned 400");
  });
});

describe("triggerRunnerCron", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let deps: RunnerDeps;

  beforeEach(() => {
    mockFetch = vi.fn();
    deps = { runnerUrl: "http://runner:3000", fetchImpl: mockFetch };
  });

  const cronPayload = { prompt: "do something", directory: "/workspace/repos/test" };

  it("rejects with onRejected for 4xx errors (dead-letter)", async () => {
    mockFetch.mockResolvedValue(textResponse("invalid directory", 400));
    const onRejected = vi.fn();

    const { triggerRunnerCron } = await import("./service.js");
    const result = await triggerRunnerCron(
      cronPayload,
      "cron-1",
      deps,
      false,
      undefined,
      onRejected,
    );

    expect(result.busy).toBe(false);
    expect(onRejected).toHaveBeenCalledWith(expect.stringContaining("400"));
  });

  it("throws for 5xx errors (retryable)", async () => {
    mockFetch.mockResolvedValue(textResponse("internal error", 500));

    const { triggerRunnerCron } = await import("./service.js");
    await expect(triggerRunnerCron(cronPayload, "cron-1", deps)).rejects.toThrow(
      "Runner returned 500",
    );
  });

  it("returns busy when runner reports busy", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ busy: true }));

    const { triggerRunnerCron } = await import("./service.js");
    const result = await triggerRunnerCron(cronPayload, "cron-1", deps);
    expect(result.busy).toBe(true);
  });

  it("consumes stream body silently on success", async () => {
    const lines = ["line1", "line2"];
    mockFetch.mockResolvedValue(ndjsonResponse(lines));
    const onAccepted = vi.fn();

    const { triggerRunnerCron } = await import("./service.js");
    const result = await triggerRunnerCron(cronPayload, "cron-1", deps, false, onAccepted);

    expect(result.busy).toBe(false);
    expect(onAccepted).toHaveBeenCalled();
  });
});
