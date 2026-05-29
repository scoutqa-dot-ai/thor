import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerDeps } from "./service.ts";
import type { SlackDeps } from "./slack-api.ts";
import type { GitHubWebhookEvent } from "./github.ts";

const mockHasSessionForCorrelationKey = vi.fn<(key: string | string[]) => boolean>(() => false);

vi.mock("@thor/common", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoDirectory: () => "/workspace/repos/my-repo",
    hasSessionForCorrelationKey: (key: string | string[]) => mockHasSessionForCorrelationKey(key),
  };
});

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
  it("preserves stateless transport retry behavior for transient resolve failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(jsonResponse({ stdout: "ok", stderr: "", exitCode: 0 }));

    const { resolveApproval } = await import("./service.ts");
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

  it("rejects with onRejected for 4xx errors (dead-letter)", async () => {
    mockRunnerFetch.mockResolvedValue(textResponse("bad request", 400));
    const onRejected = vi.fn();

    const { triggerRunnerSlack } = await import("./service.ts");
    const result = await triggerRunnerSlack(
      [slackEvent],
      "key1",
      runnerDeps,
      slackDeps,
      false,
      undefined,
      () => ({ directory: "/workspace/repos/my-repo", repoName: "repo", source: "default" }),
      onRejected,
    );

    expect(result.busy).toBe(false);
    expect(result.rejected).toBe(true);
    expect(onRejected).toHaveBeenCalledWith(expect.stringContaining("400"));
  });

  it("throws for 5xx errors (retryable)", async () => {
    mockRunnerFetch.mockResolvedValue(textResponse("internal error", 500));

    const { triggerRunnerSlack } = await import("./service.ts");
    await expect(
      triggerRunnerSlack([slackEvent], "key1", runnerDeps, slackDeps, false, undefined, () => ({
        directory: "/workspace/repos/my-repo",
        repoName: "repo",
        source: "default",
      })),
    ).rejects.toThrow("Runner returned 500");
  });
});

describe("triggerRunnerCron", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let deps: RunnerDeps;

  beforeEach(() => {
    mockFetch = vi.fn();
    deps = { runnerUrl: "http://runner:3000", fetchImpl: mockFetch };
  });

  it("batches multiple cron payloads that share a correlation key", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ accepted: true }));

    const { triggerRunnerCron } = await import("./service.ts");
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
      .mockResolvedValueOnce(jsonResponse({ accepted: true }));

    const onAccepted = vi.fn();
    const { triggerRunnerGitHub } = await import("./service.ts");
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
    expect(triggerBody.triggerGithubLogin).toBe("alice");
    expect(triggerBody.directory).toBe("/workspace/repos/my-repo");
    expect(JSON.parse(triggerBody.prompt)).toEqual(githubEventBase);
    expect(onAccepted).toHaveBeenCalled();
  });

  it("dispatches pure issue comments without pending PR branch lookup", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ accepted: true }));
    const pureIssue = {
      ...githubEventBase,
      issue: { number: 42, pull_request: null },
      comment: {
        ...githubEventBase.comment,
        body: "@thor please help with this issue",
        html_url: "https://github.com/scoutqa-dot-ai/thor/issues/42#issuecomment-1",
      },
    } satisfies GitHubWebhookEvent;

    const { triggerRunnerGitHub } = await import("./service.ts");
    const result = await triggerRunnerGitHub(
      [pureIssue],
      "github:issue:thor:scoutqa-dot-ai/thor#42",
      deps,
      "http://remote-cli:3004",
      "internal-secret",
      true,
      vi.fn(),
      vi.fn(),
    );

    expect(result.busy).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("http://runner:3000/trigger");
    const triggerBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(triggerBody).toMatchObject({
      correlationKey: "github:issue:thor:scoutqa-dot-ai/thor#42",
      triggerGithubLogin: "alice",
      directory: "/workspace/repos/my-repo",
      interrupt: true,
    });
    expect(JSON.parse(triggerBody.prompt)).toMatchObject({
      event_type: "issue_comment",
      issue: { number: 42, pull_request: null },
      comment: { html_url: "https://github.com/scoutqa-dot-ai/thor/issues/42#issuecomment-1" },
    });
  });

  it("maps gh auth failures to terminal installation_gone rejection", async () => {
    mockFetch.mockResolvedValueOnce(execResponse("", "HTTP 403: forbidden", 1));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.ts");
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
      .mockResolvedValueOnce(jsonResponse({ accepted: true }));
    const onRejected = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.ts");
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

  it("returns busy without ack for non-mention events", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ busy: true }));
    const onAccepted = vi.fn();

    const { triggerRunnerGitHub } = await import("./service.ts");
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
  it("includes approval guidance when slack events and approval outcomes share a batch", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ busy: true }));
    const { triggerRunnerSlack } = await import("./service.ts");

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
      () => ({ directory: "/workspace/repos/my-repo", repoName: "my-repo", source: "default" }),
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
    expect(body.prompt).toContain("act-1");
  });
});

describe("planBatchDispatch", () => {
  const slackEvents = [
    {
      channel: "C123",
      ts: "1710000000.001",
      text: "which repo are you using?",
      user: "U123",
      type: "message" as const,
      thread_ts: "1710000000.001",
    },
  ];
  const slackDirectoryForChannel = () => ({
    directory: "/workspace/repos/thor",
    repoName: "thor",
    source: "override" as const,
    overridePath: "/workspace/memory/thor/repo-by-slack-channel/C123.txt",
  });

  beforeEach(() => {
    mockHasSessionForCorrelationKey.mockReturnValue(false);
  });

  function planSlackDispatch() {
    return import("./service.ts").then(({ planBatchDispatch }) =>
      planBatchDispatch({
        slackEvents,
        cronEvents: [],
        githubEvents: [],
        approvalOutcomes: [],
        correlationKey: "slack:thread:C123/1710000000.001",
        deps: { runnerUrl: "http://runner:3000" },
        slackDeps: noopSlackDeps(),
        slackDirectoryForChannel,
      }),
    );
  }

  it("includes Slack routing provenance when starting a new session", async () => {
    mockHasSessionForCorrelationKey.mockReturnValue(false);
    const plan = await planSlackDispatch();

    expect(plan.kind).toBe("dispatch");
    if (plan.kind !== "dispatch") return;

    expect(plan.options.prompt).toContain("[Slack routing]");
    expect(plan.options.prompt).toContain("routed to repo `thor` via override file");
    expect(plan.options.prompt).toContain(
      "replace the contents of `/workspace/memory/thor/repo-by-slack-channel/C123.txt`",
    );
  });

  it("omits Slack routing provenance when the session already exists", async () => {
    mockHasSessionForCorrelationKey.mockReturnValue(true);
    const plan = await planSlackDispatch();

    expect(plan.kind).toBe("dispatch");
    if (plan.kind !== "dispatch") return;

    expect(plan.options.prompt).not.toContain("[Slack routing]");
  });

  describe("pending Slack privacy resolution", () => {
    type SlackClientLike = {
      conversations: { info: ReturnType<typeof vi.fn> };
      reactions: { add: ReturnType<typeof vi.fn> };
    };
    function slackDepsWith(client: SlackClientLike): SlackDeps {
      return { client: client as unknown as SlackDeps["client"] };
    }

    beforeEach(async () => {
      const { __resetSlackChannelGateCacheForTests } = await import("./slack-api.ts");
      __resetSlackChannelGateCacheForTests();
    });

    const pendingEvent = {
      channel: "C_DEFER",
      ts: "1710000000.500",
      text: "<@U999> ping",
      user: "U123",
      type: "app_mention" as const,
    };

    async function planPendingPrivacy(opts: {
      slackDeps: SlackDeps;
      workspaceConfigLoader?: () => unknown;
    }) {
      const { planBatchDispatch } = await import("./service.ts");
      return planBatchDispatch({
        slackEvents: [pendingEvent],
        cronEvents: [],
        githubEvents: [],
        approvalOutcomes: [],
        correlationKey: "pending:slack-privacy:C_DEFER:Ev1",
        deps: { runnerUrl: "http://runner:3000" },
        slackDeps: opts.slackDeps,
        workspaceConfigLoader: opts.workspaceConfigLoader as never,
      });
    }

    it("reroutes to the resolved key when the channel is public", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi.fn().mockResolvedValue({ ok: true, channel: { is_private: false } }),
        },
        reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
      };

      const plan = await planPendingPrivacy({ slackDeps: slackDepsWith(client) });

      expect(plan.kind).toBe("reroute");
      if (plan.kind !== "reroute") return;
      expect(plan.logPrefix).toBe("slack");
      expect(plan.fromCorrelationKey).toBe("pending:slack-privacy:C_DEFER:Ev1");
      expect(plan.toCorrelationKey).toBe("slack:thread:C_DEFER/1710000000.500");
      expect(plan.slackEvents).toEqual([pendingEvent]);
      expect(client.reactions.add).not.toHaveBeenCalled();
    });

    it("reroutes when the resolved private channel is allowlisted", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi.fn().mockResolvedValue({ ok: true, channel: { is_private: true } }),
        },
        reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
      };

      const plan = await planPendingPrivacy({
        slackDeps: slackDepsWith(client),
        workspaceConfigLoader: () => ({ slack: { private_channel_allowlist: ["C_DEFER"] } }),
      });

      expect(plan.kind).toBe("reroute");
    });

    it("drops with private_channel_not_allowlisted when the resolved channel is private and unallowlisted", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi.fn().mockResolvedValue({ ok: true, channel: { is_private: true } }),
        },
        reactions: { add: vi.fn() },
      };

      const plan = await planPendingPrivacy({
        slackDeps: slackDepsWith(client),
        workspaceConfigLoader: () => ({}),
      });

      expect(plan).toEqual({
        kind: "drop",
        logPrefix: "slack",
        reason: "private_channel_not_allowlisted",
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: "C_DEFER",
        timestamp: "1710000000.500",
        name: "lock",
      });
    });

    it("drops with private_channel_not_allowlisted when the resolved public channel is externally shared", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi
            .fn()
            .mockResolvedValue({ ok: true, channel: { is_private: false, is_ext_shared: true } }),
        },
        reactions: { add: vi.fn() },
      };

      const plan = await planPendingPrivacy({
        slackDeps: slackDepsWith(client),
        workspaceConfigLoader: () => ({}),
      });

      expect(plan).toEqual({
        kind: "drop",
        logPrefix: "slack",
        reason: "private_channel_not_allowlisted",
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: "C_DEFER",
        timestamp: "1710000000.500",
        name: "lock",
      });
    });

    it("fails closed when conversations.info errors", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi.fn().mockRejectedValue(new Error("slack down")),
        },
        reactions: { add: vi.fn() },
      };

      const plan = await planPendingPrivacy({
        slackDeps: slackDepsWith(client),
        workspaceConfigLoader: () => ({}),
      });

      expect(plan).toEqual({
        kind: "drop",
        logPrefix: "slack",
        reason: "private_channel_not_allowlisted",
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: "C_DEFER",
        timestamp: "1710000000.500",
        name: "lock",
      });
    });

    it("fails closed when the workspace config loader throws", async () => {
      const client: SlackClientLike = {
        conversations: {
          info: vi.fn().mockResolvedValue({ ok: true, channel: { is_private: true } }),
        },
        reactions: { add: vi.fn() },
      };

      const plan = await planPendingPrivacy({
        slackDeps: slackDepsWith(client),
        workspaceConfigLoader: () => {
          throw new Error("config unavailable");
        },
      });

      expect(plan).toEqual({
        kind: "drop",
        logPrefix: "slack",
        reason: "private_channel_not_allowlisted",
      });
      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: "C_DEFER",
        timestamp: "1710000000.500",
        name: "lock",
      });
    });
  });
});

describe("triggerRunnerApprovalOutcomes", () => {
  it("returns after acceptance without waiting for the runner body to finish", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accepted: true }));
    const onAccepted = vi.fn();
    const { triggerRunnerApprovalOutcomes } = await import("./service.ts");

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
      () => ({ directory: "/workspace/repos/my-repo", repoName: "my-repo", source: "default" }),
    );

    const outcome = await Promise.race([
      resultPromise.then((result) => ({ kind: "resolved" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 25),
      ),
    ]);

    expect(outcome).toEqual({ kind: "resolved", result: { busy: false } });
    expect(onAccepted).toHaveBeenCalledTimes(1);

    await resultPromise;
  });
});
