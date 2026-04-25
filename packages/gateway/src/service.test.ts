import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerDeps, SlackMcpDeps } from "./service.js";

// Helper: create a ReadableStream from NDJSON lines
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

// Helper: create a mock Response with NDJSON body
function ndjsonResponse(lines: string[], status = 200): Response {
  return new Response(ndjsonStream(lines), {
    status,
    headers: { "content-type": "application/x-ndjson" },
  });
}

// Helper: create a mock Response with JSON body
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
  let slackMcpDeps: SlackMcpDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    mockSlackFetch = vi.fn().mockResolvedValue(new Response("ok"));
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackMcpDeps = { slackMcpUrl: "http://slack-mcp:3003", fetchImpl: mockSlackFetch };

    // Mock resolveRepoDirectory to return a directory
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
  };
  const channelRepos = new Map([["C123", "my-repo"]]);

  it("forwards progress events to slack-mcp", async () => {
    const lines = [
      JSON.stringify({ type: "start", sessionId: "s1", resumed: false }),
      JSON.stringify({ type: "tool", tool: "bash", status: "completed" }),
      JSON.stringify({
        type: "memory",
        action: "read",
        path: "/workspace/memory/my-repo/README.md",
        source: "bootstrap",
      }),
      JSON.stringify({
        type: "delegate",
        agent: "research-agent",
      }),
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
      slackMcpDeps,
      false,
      undefined,
      channelRepos,
    );
    expect(result.busy).toBe(false);

    // Wait for background stream consumption
    await new Promise((r) => setTimeout(r, 50));

    // Gateway forwards progress events directly, including sourceTs for Slack-side decisions.
    const progressCalls = mockSlackFetch.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("/progress"),
    );
    expect(progressCalls.length).toBe(5);

    const body = JSON.parse((progressCalls[0][1] as { body: string }).body);
    expect(body.sourceTs).toBe("1710000000.001");
    const memoryBody = JSON.parse((progressCalls[2][1] as { body: string }).body);
    expect(memoryBody.event.type).toBe("memory");
    const delegateBody = JSON.parse((progressCalls[3][1] as { body: string }).body);
    expect(delegateBody.event.type).toBe("delegate");
  });

  it("forwards approval_required events to /approval endpoint", async () => {
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
      slackMcpDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const approvalCalls = mockSlackFetch.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("/approval"),
    );
    expect(approvalCalls.length).toBe(1);
    const body = JSON.parse((approvalCalls[0][1] as { body: string }).body);
    expect(body.actionId).toBe("act-1");
    expect(body.tool).toBe("merge_pull_request");
    expect(body.proxyName).toBe("github");
  });

  it("skips invalid NDJSON lines without crashing", async () => {
    const lines = [
      "not valid json",
      JSON.stringify({ type: "tool", tool: "bash", status: "completed" }),
      JSON.stringify({ unknown: "schema" }), // valid JSON but not a ProgressEvent
      "",
    ];
    mockRunnerFetch.mockResolvedValue(ndjsonResponse(lines));

    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackMcpDeps,
      false,
      undefined,
      channelRepos,
    );
    expect(result.busy).toBe(false);

    await new Promise((r) => setTimeout(r, 50));

    // Gateway still forwards valid progress events directly.
    const progressCalls = mockSlackFetch.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("/progress"),
    );
    expect(progressCalls.length).toBe(1);
  });

  it("forwards sourceTs on early errors for Slack-side suppression", async () => {
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
      slackMcpDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const progressCalls = mockSlackFetch.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("/progress"),
    );
    expect(progressCalls.length).toBe(3);
    const body = JSON.parse((progressCalls[2][1] as { body: string }).body);
    expect(body.sourceTs).toBe("1710000000.001");
    expect(body.event.type).toBe("done");
    expect(body.event.status).toBe("error");
  });

  it("handles chunked delivery across newline boundaries", async () => {
    // Simulate a stream that splits a JSON line across two chunks
    const line1 = JSON.stringify({ type: "tool", tool: "read", status: "completed" });
    const line2 = JSON.stringify({ type: "tool", tool: "write", status: "completed" });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        // Split line1 in the middle
        const full = line1 + "\n" + line2 + "\n";
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
      slackMcpDeps,
      false,
      undefined,
      channelRepos,
    );

    await new Promise((r) => setTimeout(r, 50));

    const progressCalls = mockSlackFetch.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("/progress"),
    );
    expect(progressCalls.length).toBe(2);
  });
});

describe("triggerRunnerSlack edge cases", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackMcpDeps: SlackMcpDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackMcpDeps = { slackMcpUrl: "http://slack-mcp:3003", fetchImpl: vi.fn() };
  });

  const slackEvent = {
    channel: "C123",
    ts: "1710000000.001",
    thread_ts: "1710000000.001",
    text: "hello",
    user: "U1",
    type: "message",
  };

  it("returns early for empty events", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack([], "key1", runnerDeps, slackMcpDeps);
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
      slackMcpDeps,
      false,
      undefined,
      new Map(), // empty map — no repo for C123
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
      slackMcpDeps,
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
        slackMcpDeps,
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
