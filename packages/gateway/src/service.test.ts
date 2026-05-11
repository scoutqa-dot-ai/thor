import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerDeps } from "./service.js";
import type { SlackDeps } from "./slack-api.js";
import type { GitHubWebhookEvent } from "./github.js";

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

function execResponse(stdout: unknown, stderr = "", exitCode = 0): Response {
  return jsonResponse({
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr,
    exitCode,
  });
}

function noopSlackDeps(): SlackDeps {
  return { client: {} } as unknown as SlackDeps;
}

function parseRunnerSlackPrompt(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const triggerBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  const promptJson = String(triggerBody.prompt).split("\n\n").slice(1).join("\n\n");
  return JSON.parse(promptJson);
}

const githubEventBase: GitHubWebhookEvent = {
  event_type: "issue_comment",
  action: "created",
  installation: { id: 126669985 },
  repository: { full_name: "scoutqa-dot-ai/thor" },
  sender: { id: 1001, login: "alice", type: "User" },
  issue: {
    number: 42,
    pull_request: { html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42" },
  },
  comment: {
    body: "@thor please review this branch",
    html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#issuecomment-1",
    created_at: "2026-04-24T11:00:00Z",
  },
};

function githubReviewCommentPayload(): GitHubWebhookEvent {
  return {
    event_type: "pull_request_review_comment",
    action: "created",
    installation: { id: 126669985 },
    repository: { full_name: "scoutqa-dot-ai/thor" },
    sender: { id: 1001, login: "Alice", type: "User" },
    pull_request: {
      number: 42,
      user: { id: 1001, login: "alice" },
      head: { ref: "main", repo: { full_name: "scoutqa-dot-ai/thor" } },
      base: { repo: { full_name: "scoutqa-dot-ai/thor" } },
    },
    comment: {
      body: "Please   check this @thor",
      html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r1",
      created_at: "2026-04-24T11:00:00Z",
    },
  };
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
      "internal-secret",
      fetchImpl,
      "ship it",
    );

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledWith("http://remote-cli:3004/exec/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-thor-internal-secret": "internal-secret",
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

  it("returns nonzero results when an approved upstream call fails after resolution", async () => {
    const failedResult = {
      stdout: "",
      stderr: 'Error calling "merge_pull_request": upstream unavailable\n',
      exitCode: 1,
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(failedResult));

    const { resolveApproval } = await import("./service.js");
    const result = await resolveApproval(
      "act-1",
      "approved",
      "U123",
      "http://remote-cli:3004",
      "resolve-secret",
      fetchImpl,
    );

    expect(result).toEqual(failedResult);
  });

  it("preserves stateless transport retry behavior for transient resolve failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(jsonResponse({ stdout: "ok", stderr: "", exitCode: 0 }));

    const { resolveApproval } = await import("./service.js");
    const result = await resolveApproval(
      "act-1",
      "approved",
      "U123",
      "http://remote-cli:3004",
      "internal-secret",
      fetchImpl,
    );

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("consumeNdjsonStream (via triggerRunnerSlack)", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let postMessage: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let reactionsAdd: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackDeps: SlackDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "msg.001", channel: "C123" });
    update = vi.fn().mockResolvedValue({ ok: true });
    del = vi.fn().mockResolvedValue({ ok: true });
    reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackDeps = {
      client: {
        chat: { postMessage, update, delete: del },
        reactions: { add: reactionsAdd },
      },
    } as unknown as SlackDeps;

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
        type: "memory",
        action: "write",
        path: "/workspace/memory/my-repo/README.md",
        source: "tool",
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
      slackDeps,
      false,
      undefined,
      channelRepos,
    );
    expect(result.busy).toBe(false);

    await new Promise((r) => setTimeout(r, 50));

    expect(postMessage).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
    const updateTexts = update.mock.calls.map(([arg]) => (arg as { text: string }).text);
    expect(updateTexts.some((t) => t.includes("memory: README.md"))).toBe(true);
    expect(updateTexts.some((t) => t.includes("agents: research-agent"))).toBe(true);
  });

  it("posts approval_required events with v3 button payload format", async () => {
    const lines = [
      JSON.stringify({
        type: "approval_required",
        actionId: "act-1",
        tool: "createJiraIssue",
        args: {
          cloudId: "cloud-1",
          projectKey: "ENG",
          issueTypeName: "Task",
          summary: "Approval card",
          description: "Review me",
        },
        proxyName: "atlassian",
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

    expect(postMessage).toHaveBeenCalled();
    const arg = postMessage.mock.calls[0][0] as {
      blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }>;
    };
    const approveButton = arg.blocks[3].elements?.find((el) => el.action_id === "approval_approve");
    expect(approveButton?.value).toBe("v3:act-1:atlassian:1710000000.001");
    expect(JSON.stringify(arg.blocks)).toContain("Create Jira issue: Approval card");
  });

  it("renders configured approval tools with markdown presentation blocks", async () => {
    const lines = [
      JSON.stringify({
        type: "approval_required",
        actionId: "act-2",
        tool: "create-feature-flag",
        args: { key: "beta-card", name: "Beta card", description: "Enable the new card" },
        proxyName: "posthog",
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

    expect(postMessage).toHaveBeenCalled();
    const arg = postMessage.mock.calls[0][0] as {
      text: string;
      blocks: Array<{
        text?: { text: string };
        elements?: Array<{ action_id: string; value: string }>;
      }>;
    };
    expect(arg.text).toBe("Create feature flag: Beta card");
    expect(arg.blocks[0].text?.text).toBe(":lock: *Create feature flag: Beta card*");
    expect(arg.blocks[1].text?.text).toContain("*Description:*\nEnable the new card");
    expect(arg.blocks[1].text?.text).not.toContain("```json");
    const approveButton = arg.blocks[3].elements?.find((el) => el.action_id === "approval_approve");
    expect(approveButton?.value).toBe("v3:act-2:posthog:1710000000.001");
  });

  it("falls back to inline raw JSON when a configured approval payload fails strict parsing", async () => {
    const lines = [
      JSON.stringify({
        type: "approval_required",
        actionId: "act-3",
        tool: "addCommentToJiraIssue",
        args: { issueKey: "ENG-42", commentBody: "Legacy alias payload" },
        proxyName: "atlassian",
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

    expect(postMessage).toHaveBeenCalled();
    const arg = postMessage.mock.calls[0][0] as {
      text: string;
      blocks: Array<{
        text?: { text: string };
        elements?: Array<{ action_id: string; value: string }>;
      }>;
    };
    expect(arg.text).toBe("Approval required for `addCommentToJiraIssue`");
    expect(arg.blocks[0].text?.text).toBe(":lock: *Approval required* — `addCommentToJiraIssue`");
    expect(arg.blocks[1].text?.text).toContain("```json");
    expect(arg.blocks[1].text?.text).toContain('"issueKey": "ENG-42"');
    const approveButton = arg.blocks[3].elements?.find((el) => el.action_id === "approval_approve");
    expect(approveButton?.value).toBe("v3:act-3:atlassian:1710000000.001");
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
    expect(postMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(reactionsAdd).not.toHaveBeenCalled();
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

    expect(reactionsAdd).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.001",
      name: "x",
    });
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

    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("triggerRunnerSlack edge cases", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackDeps: SlackDeps;

  beforeEach(() => {
    mockRunnerFetch = vi.fn();
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackDeps = noopSlackDeps();
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

  it("rejects with onRejected for 4xx errors (dead-letter)", async () => {
    mockRunnerFetch.mockResolvedValue(textResponse("bad request", 400));
    const onRejected = vi.fn();

    const { triggerRunnerSlack } = await import("./service.js");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      new Map([["C123", "repo"]]),
      onRejected,
    );

    expect(result.busy).toBe(false);
    expect(result.rejected).toBe(true);
    expect(onRejected).toHaveBeenCalledWith(expect.stringContaining("400"));
  });

  it("throws for 5xx errors (retryable)", async () => {
    mockRunnerFetch.mockResolvedValue(textResponse("internal error", 500));

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
    ).rejects.toThrow("Runner returned 500");
  });
});

describe("triggerRunnerSlack prompt distillation", () => {
  let mockRunnerFetch: ReturnType<typeof vi.fn>;
  let runnerDeps: RunnerDeps;
  let slackDeps: SlackDeps;
  const channelRepos = new Map([["C123", "my-repo"]]);

  beforeEach(() => {
    mockRunnerFetch = vi.fn().mockResolvedValue(ndjsonResponse([JSON.stringify({ type: "done" })]));
    runnerDeps = { runnerUrl: "http://runner:3000", fetchImpl: mockRunnerFetch };
    slackDeps = noopSlackDeps();
  });

  it("renders an allowlisted Slack payload without raw noisy fields", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [
        {
          type: "message",
          channel: "C123",
          ts: "1710000000.001",
          thread_ts: "1710000000.001",
          user: "U123",
          text: "please inspect this",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "secret block text" } }],
          bot_profile: { name: "Thor Bot" },
          llm_notes: "do not expose",
          has_blocks: true,
          files: [
            {
              id: "F123",
              name: "debug.log",
              mimetype: "text/plain",
              filetype: "text",
              size: 42,
              url_private: "https://files.slack.com/debug.log",
              thumb_360: "https://files.slack.com/thumb.png",
              permalink: "https://slack.com/file/F123",
              user: "Alice Example",
            },
          ],
        },
      ],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    expect(parseRunnerSlackPrompt(mockRunnerFetch)).toEqual({
      event_type: "message",
      channel: "C123",
      ts: "1710000000.001",
      thread_ts: "1710000000.001",
      user: "U123",
      text: "please inspect this",
      files: [
        { id: "F123", name: "debug.log", mimetype: "text/plain", filetype: "text", size: 42 },
      ],
      block_tags: ["section"],
    });
  });

  it("preserves lean Slack file identity and access placeholders before metadata hydration", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [
        {
          type: "message",
          channel: "C123",
          ts: "1710000000.004",
          user: "U123",
          text: "shared a Slack Connect file",
          files: [
            {
              id: "FCONNECT",
              file_access: "check_file_info",
              url_private: "https://files.slack.com/hidden",
              user: "Alice Example",
            },
          ],
        },
      ],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    expect(parseRunnerSlackPrompt(mockRunnerFetch)).toEqual({
      event_type: "message",
      channel: "C123",
      ts: "1710000000.004",
      user: "U123",
      text: "shared a Slack Connect file",
      files: [{ id: "FCONNECT", file_access: "check_file_info" }],
    });
  });

  it("extracts stable deduplicated block_tags without text, names, or urls", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [
        {
          type: "app_mention",
          channel: "C123",
          ts: "1710000000.002",
          user: "U999",
          text: "<@UTHOR> inspect rich blocks",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "user", user_id: "U123", name: "Alice" },
                    { type: "channel", channel_id: "C456", name: "general" },
                    { type: "usergroup", usergroup_id: "S789", name: "admins" },
                    { type: "broadcast", range: "here" },
                    { type: "emoji", name: "wave" },
                    { type: "link", url: "https://example.com/private" },
                    { type: "date", timestamp: 1710000000 },
                    { type: "user", user_id: "U123", name: "Alice" },
                  ],
                },
                { type: "rich_text_list", elements: [] },
                { type: "rich_text_quote", elements: [] },
                { type: "rich_text_preformatted", elements: [{ type: "text", text: "secret" }] },
                { type: "file", file_id: "FSECRET" },
              ],
            },
          ],
        },
      ],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    const payload = parseRunnerSlackPrompt(mockRunnerFetch) as { block_tags: string[] };
    expect(payload.block_tags).toEqual([
      "rich_text",
      "rich_text_section",
      "user:U123",
      "channel:C456",
      "usergroup:S789",
      "broadcast:here",
      "emoji:wave",
      "link",
      "date",
      "rich_text_list",
      "rich_text_quote",
      "rich_text_preformatted",
      "file",
    ]);
    expect(JSON.stringify(payload)).not.toContain("Alice");
    expect(JSON.stringify(payload)).not.toContain("https://example.com/private");
    expect(JSON.stringify(payload)).not.toContain("FSECRET");
  });

  it("renders multiple Slack events as an array of distilled objects", async () => {
    const { triggerRunnerSlack } = await import("./service.js");
    await triggerRunnerSlack(
      [
        { type: "message", channel: "C123", ts: "1", user: "U1", text: "one" },
        { type: "message", channel: "C123", ts: "2", user: "U2", text: "two" },
      ],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      channelRepos,
    );

    expect(parseRunnerSlackPrompt(mockRunnerFetch)).toEqual([
      { event_type: "message", channel: "C123", ts: "1", user: "U1", text: "one" },
      { event_type: "message", channel: "C123", ts: "2", user: "U2", text: "two" },
    ]);
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

  it("batches multiple cron payloads that share a correlation key", async () => {
    mockFetch.mockResolvedValue(ndjsonResponse(["line1"]));

    const { triggerRunnerCron } = await import("./service.js");
    const result = await triggerRunnerCron(
      [
        { prompt: "do something", directory: "/workspace/repos/test" },
        { prompt: "do the follow-up", directory: "/workspace/repos/test" },
      ],
      "cron-1",
      deps,
    );

    expect(result.busy).toBe(false);
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(triggerBody.prompt).toBe("Cron events:\n\ndo something\n\ndo the follow-up");
  });
});

describe("triggerRunnerGitHub", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let deps: RunnerDeps;

  beforeEach(() => {
    mockFetch = vi.fn();
    deps = { runnerUrl: "http://runner:3000", fetchImpl: mockFetch };
  });

  it("resolves pending branch then dispatches runner with canonical correlation key", async () => {
    mockFetch
      .mockResolvedValueOnce(
        execResponse({
          headRefName: "feature/refactor",
          headRepositoryOwner: { login: "scoutqa-dot-ai" },
          headRepository: { name: "thor" },
        }),
      )
      .mockResolvedValueOnce(
        ndjsonResponse([JSON.stringify({ type: "done", status: "completed" })]),
      );

    const onAccepted = vi.fn();
    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      onAccepted,
      vi.fn(),
    );

    expect(result.busy).toBe(false);
    expect(mockFetch.mock.calls[0][0]).toBe("http://remote-cli:3004/internal/exec");
    expect(mockFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "x-thor-internal-secret": "internal-secret" },
    });
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toMatchObject({
      bin: "gh",
      args: [
        "pr",
        "view",
        "42",
        "--repo",
        "scoutqa-dot-ai/thor",
        "--json",
        "headRefName,headRepository,headRepositoryOwner",
      ],
      cwd: "/workspace/repos/my-repo",
    });
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(triggerBody.correlationKey).toBe("git:branch:thor:feature/refactor");
    expect(triggerBody.directory).toBe("/workspace/repos/my-repo");
    expect(JSON.parse(triggerBody.prompt)).toEqual(githubEventBase);
    expect(onAccepted).toHaveBeenCalled();
  });

  it("renders single GitHub events as the parsed JSON envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonResponse([JSON.stringify({ type: "done", status: "completed" })]),
    );

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubReviewCommentPayload()],
      "git:branch:thor:feature/refactor",
      deps,
      "http://remote-cli:3004",
    );

    expect(result.busy).toBe(false);
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(JSON.parse(triggerBody.prompt)).toEqual(githubReviewCommentPayload());
  });

  it("renders multiple GitHub events as a JSON array of parsed envelopes", async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonResponse([JSON.stringify({ type: "done", status: "completed" })]),
    );

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubReviewCommentPayload(), githubEventBase],
      "git:branch:thor:feature/refactor",
      deps,
      "http://remote-cli:3004",
    );

    expect(result.busy).toBe(false);
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(JSON.parse(triggerBody.prompt)).toEqual([githubReviewCommentPayload(), githubEventBase]);
  });

  it("maps gh auth failures to terminal installation_gone rejection", async () => {
    mockFetch.mockResolvedValueOnce(execResponse("", "HTTP 403: forbidden", 1));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result.busy).toBe(false);
    expect(onRejected).toHaveBeenCalledWith("installation_gone");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("reroutes pending branch issue comments even when gh resolves a fork PR head", async () => {
    mockFetch
      .mockResolvedValueOnce(
        execResponse({
          headRefName: "feature/refactor",
          headRepositoryOwner: { login: "alice" },
          headRepository: { name: "thor" },
        }),
      )
      .mockResolvedValueOnce(
        ndjsonResponse([JSON.stringify({ type: "done", status: "completed" })]),
      );
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false });
    expect(onRejected).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("maps gh not found failures to terminal branch_not_found rejection", async () => {
    mockFetch.mockResolvedValueOnce(execResponse("", "HTTP 404: not found", 1));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false, rejected: true, reason: "branch_not_found" });
    expect(onRejected).toHaveBeenCalledWith("branch_not_found");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maps gh lookup failures to terminal branch_lookup_failed", async () => {
    mockFetch.mockResolvedValueOnce(execResponse("", "upstream error", 1));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false, rejected: true, reason: "branch_lookup_failed" });
    expect(onRejected).toHaveBeenCalledWith("branch_lookup_failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maps non-OK internal exec responses to terminal branch_lookup_failed", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("Unauthorized", 401));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false, rejected: true, reason: "branch_lookup_failed" });
    expect(onRejected).toHaveBeenCalledWith("branch_lookup_failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maps internal exec transport failures to terminal branch_lookup_failed", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false, rejected: true, reason: "branch_lookup_failed" });
    expect(onRejected).toHaveBeenCalledWith("branch_lookup_failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maps malformed gh output to terminal branch_lookup_failed", async () => {
    mockFetch.mockResolvedValueOnce(execResponse({ headRefName: "feature/refactor" }));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubEventBase],
      "pending:branch-resolve:delivery-1",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      undefined,
      onRejected,
    );

    expect(result).toEqual({ busy: false, rejected: true, reason: "branch_lookup_failed" });
    expect(onRejected).toHaveBeenCalledWith("branch_lookup_failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns busy without ack for non-mention events", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ busy: true }));
    const onAccepted = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.js");
    const result = await triggerRunnerGitHub(
      [githubReviewCommentPayload()],
      "git:branch:thor:main",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      false,
      onAccepted,
    );

    expect(result.busy).toBe(true);
    expect(onAccepted).not.toHaveBeenCalled();
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(triggerBody.interrupt).toBe(false);
  });
});

describe("approval outcome prompts", () => {
  it("builds approved and rejected re-entry guidance", async () => {
    const { buildApprovalOutcomePrompt } = await import("./service.js");
    const prompt = buildApprovalOutcomePrompt([
      {
        actionId: "act-1",
        decision: "approved",
        reviewer: "U123",
        channel: "C123",
        threadTs: "1710000000.001",
        upstreamName: "github",
        tool: "merge_pull_request",
      },
      {
        actionId: "act-2",
        decision: "rejected",
        reviewer: "U456",
        channel: "C123",
        threadTs: "1710000000.001",
        upstreamName: "github",
        tool: "close_issue",
        resolutionSummary: "missing approval reason",
      },
    ]);

    expect(prompt).toContain("human approved action `act-1`");
    expect(prompt).toContain("continue the workflow");
    expect(prompt).toContain("human rejected action `act-2`");
    expect(prompt).toContain("do not retry the same write blindly");
    expect(prompt).toContain("Resolution summary: missing approval reason");
  });

  it("builds failure guidance when approval resolution returns a nonzero exit", async () => {
    const { buildApprovalOutcomePrompt } = await import("./service.js");
    const prompt = buildApprovalOutcomePrompt([
      {
        actionId: "act-1",
        decision: "approved",
        reviewer: "U123",
        channel: "C123",
        threadTs: "1710000000.001",
        upstreamName: "github",
        resolutionExitCode: 1,
        resolutionSummary: 'Error calling "merge_pull_request": upstream unavailable',
      },
    ]);

    expect(prompt).toContain(
      "human approved action `act-1`, but approval resolution reported a failure",
    );
    expect(prompt).toContain("choose the next safe action");
    expect(prompt).toContain(
      'Resolution summary: Error calling "merge_pull_request": upstream unavailable',
    );
  });

  it("includes approval guidance when slack events and approval outcomes share a batch", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ busy: true }));
    const { triggerRunnerSlack } = await import("./service.js");

    const result = await triggerRunnerSlack(
      [
        {
          channel: "C123",
          ts: "1710000000.001",
          text: "continue",
          user: "U123",
          type: "message",
          thread_ts: "1710000000.001",
        },
      ],
      "slack:thread:1710000000.001",
      { runnerUrl: "http://runner:3000", fetchImpl },
      noopSlackDeps(),
      false,
      undefined,
      new Map([["C123", "my-repo"]]),
      undefined,
      [
        {
          actionId: "act-1",
          decision: "approved",
          reviewer: "U123",
          channel: "C123",
          threadTs: "1710000000.001",
          upstreamName: "github",
          tool: "merge_pull_request",
        },
      ],
    );

    expect(result.busy).toBe(true);
    const req = fetchImpl.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(req.body);
    expect(body.prompt).toContain("Slack event:");
    expect(body.prompt).toContain("human approved action `act-1`");
    expect(body.prompt).toContain("continue the workflow");
  });
});

describe("triggerRunnerApprovalOutcomes", () => {
  it("returns busy when runner reports busy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ busy: true }));
    const { triggerRunnerApprovalOutcomes } = await import("./service.js");

    const result = await triggerRunnerApprovalOutcomes(
      [
        {
          actionId: "act-1",
          decision: "approved",
          reviewer: "U123",
          channel: "C123",
          threadTs: "1710000000.001",
        },
      ],
      "slack:thread:1710000000.001",
      { runnerUrl: "http://runner:3000", fetchImpl },
      noopSlackDeps(),
      false,
      undefined,
      new Map([["C123", "my-repo"]]),
    );

    expect(result.busy).toBe(true);
    const req = fetchImpl.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(req.body);
    expect(body.interrupt).toBe(false);
    expect(body.correlationKey).toBe("slack:thread:1710000000.001");
  });

  it("returns after acceptance without waiting for the runner body to finish", async () => {
    let closeStream: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("pending"));
        closeStream = () => controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const onAccepted = vi.fn();
    const { triggerRunnerApprovalOutcomes } = await import("./service.js");

    const resultPromise = triggerRunnerApprovalOutcomes(
      [
        {
          actionId: "act-1",
          decision: "approved",
          reviewer: "U123",
          channel: "C123",
          threadTs: "1710000000.001",
        },
      ],
      "slack:thread:1710000000.001",
      { runnerUrl: "http://runner:3000", fetchImpl },
      noopSlackDeps(),
      false,
      onAccepted,
      new Map([["C123", "my-repo"]]),
    );

    const outcome = await Promise.race([
      resultPromise.then((result) => ({ kind: "resolved" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 25),
      ),
    ]);

    expect(outcome).toEqual({ kind: "resolved", result: { busy: false } });
    expect(onAccepted).toHaveBeenCalledTimes(1);

    closeStream?.();
    await resultPromise;
  });
});
