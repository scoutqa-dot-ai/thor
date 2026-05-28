import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appendAlias, appendSessionEvent, formatThorContextFooter } from "@thor/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteCliApp } from "./index.js";
import type { UpstreamConnection } from "./upstream.js";

const tools: Tool[] = [
  {
    name: "getJiraIssue",
    description: "Get a Jira issue",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "createJiraIssue",
    description: "Create a Jira issue",
    inputSchema: {
      type: "object",
      properties: { projectKey: { type: "string" }, summary: { type: "string" } },
      required: ["projectKey", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "createIssueLink",
    description: "Create a Jira issue link",
    inputSchema: {
      type: "object",
      properties: {
        outwardIssueIdOrKey: { type: "string" },
        inwardIssueIdOrKey: { type: "string" },
        linkType: { type: "string" },
      },
      required: ["outwardIssueIdOrKey", "inwardIssueIdOrKey", "linkType"],
      additionalProperties: false,
    },
  },
  {
    name: "lookupJiraAccountId",
    description: "Resolve a Jira account id",
    inputSchema: {
      type: "object",
      properties: { cloudId: { type: "string" }, searchString: { type: "string" } },
    },
  },
  {
    name: "hiddenTool",
    description: "Should stay hidden",
    inputSchema: { type: "object" },
  },
];

const worklogDir = "/tmp/thor-remote-cli-mcp-test/worklog";
const activeTriggerId = "00000000-0000-7000-8000-000000000101";
const githubTriggerId = "00000000-0000-7000-8000-000000000102";
const activeAnchorId = "00000000-0000-7000-8000-0000000004a1";
const activeSlackCorrelationKey = "slack:thread:C123/1710000000.001";

function jiraLookupResponse(users: Array<{ accountId: string; displayName?: string }>) {
  return {
    data: {
      users: {
        users,
        total: users.length,
        header: `Showing ${users.length} of ${users.length} matching users`,
      },
      groups: {
        header: "Showing 0 of 0 matching groups",
        total: 0,
        groups: [],
      },
    },
    statusCode: 200,
  };
}

function appendActiveTrigger(extra: Record<string, unknown> = {}) {
  appendSessionEvent("parent-session", {
    type: "trigger_start",
    triggerId: activeTriggerId,
    correlationKey: activeSlackCorrelationKey,
    ...extra,
  });
}

describe("remote-cli MCP endpoints", () => {
  let approvalsDir: string;
  let server: Server;
  let baseUrl: string;
  let toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  let createJiraIssueDelay: Promise<void> | undefined;
  let createJiraIssueFailure: Error | undefined;
  let createJiraIssueErrorResponse: string | undefined;
  let toolCallLogEntries: Array<Record<string, unknown>>;
  let connectedUpstreams: string[];
  let closeRemoteCli: () => Promise<void>;
  let jiraLookups: Array<Record<string, unknown> | undefined>;
  let jiraLookupResultText: string;
  let jiraLookupFailure: Error | undefined;
  let slackFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic dGVzdA==");
    vi.stubEnv("POSTHOG_API_KEY", "test-posthog-key");
    vi.stubEnv("THOR_INTERNAL_SECRET", "resolve-secret");
    vi.stubEnv("WORKLOG_DIR", worklogDir);
    vi.stubEnv("RUNNER_BASE_URL", "https://thor.example.com/");
    rmSync("/tmp/thor-remote-cli-mcp-test", { recursive: true, force: true });
    approvalsDir = mkdtempSync(join(tmpdir(), "remote-cli-mcp-"));
    toolCalls = [];
    createJiraIssueDelay = undefined;
    createJiraIssueFailure = undefined;
    createJiraIssueErrorResponse = undefined;
    toolCallLogEntries = [];
    connectedUpstreams = [];
    jiraLookups = [];
    jiraLookupResultText = JSON.stringify(jiraLookupResponse([{ accountId: "jira-account-1" }]));
    jiraLookupFailure = undefined;
    slackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1710000000.100" })),
      );
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendAlias({
      aliasType: "slack.thread",
      aliasValue: "C123/1710000000.001",
      anchorId: activeAnchorId,
    });

    const remoteCli = createRemoteCliApp({
      env: {
        port: 3004,
        nodeEnv: "test",
        slackBotToken: "xoxb-test",
        slackApiBaseUrl: "https://slack.test/api",
        thorInternalSecret: "resolve-secret",
        githubAppId: "app-id",
        githubAppSlug: "thor-github-app",
        githubAppBotId: "12345",
        githubAppPrivateKeyFile: "/tmp/private-key.pem",
        gitIdentityName: "thor[bot]",
        gitIdentityEmail: "thor@example.com",
      },
      mcp: {
        approvalsDir,
        isProduction: true,
        fetchImpl: slackFetch,
        writeToolCallLogFn: (entry) => {
          toolCallLogEntries.push(entry as unknown as Record<string, unknown>);
        },
        configLoader: () => ({
          users: [
            { email: "alice@example.com", name: "Alice", slack: "UABCDEF1", github: "alice" },
          ],
        }),
        connectUpstreamFn: async (name: string): Promise<UpstreamConnection> => {
          connectedUpstreams.push(name);
          return {
            tools,
            client: {
              callTool: async ({
                name,
                arguments: args,
              }: {
                name: string;
                arguments?: Record<string, unknown>;
              }) => {
                toolCalls.push({ name, arguments: args });
                if (name === "getJiraIssue") {
                  return {
                    content: [{ type: "text", text: "THOR-123" }],
                  };
                }
                if (name === "createJiraIssue") {
                  await createJiraIssueDelay;
                  if (createJiraIssueFailure) {
                    const failure = createJiraIssueFailure;
                    createJiraIssueFailure = undefined;
                    throw failure;
                  }
                  if (createJiraIssueErrorResponse) {
                    const errorText = createJiraIssueErrorResponse;
                    createJiraIssueErrorResponse = undefined;
                    return {
                      isError: true,
                      content: [{ type: "text", text: errorText }],
                    };
                  }
                  return {
                    content: [{ type: "text", text: "created" }],
                  };
                }
                if (name === "createIssueLink") {
                  return {
                    content: [{ type: "text", text: "linked" }],
                  };
                }
                if (name === "lookupJiraAccountId") {
                  jiraLookups.push(args);
                  if (jiraLookupFailure) throw jiraLookupFailure;
                  return {
                    content: [{ type: "text", text: jiraLookupResultText }],
                  };
                }
                throw new Error(`Unexpected tool: ${name}`);
              },
              close: async () => {},
            } as unknown as UpstreamConnection["client"],
          };
        },
      },
    });
    closeRemoteCli = remoteCli.close;

    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await closeRemoteCli();
    rmSync(approvalsDir, { recursive: true, force: true });
    rmSync("/tmp/thor-remote-cli-mcp-test", { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function approveJiraCreate(argsJson: string, triggerSlackId = "UABCDEF1") {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendSessionEvent("parent-session", {
      type: "trigger_start",
      triggerId: activeTriggerId,
      correlationKey: activeSlackCorrelationKey,
      ...(triggerSlackId ? { triggerSlackId } : {}),
    });
    const pending = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "createJiraIssue", argsJson],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const actionId = (
      JSON.parse(((await pending.json()) as { stdout: string }).stdout) as { actionId: string }
    ).actionId;

    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    expect(resolved.status).toBe(200);
    return (await resolved.json()) as { stdout: string; stderr: string; exitCode: number };
  }

  it("lists allowed upstreams and visible tools, then calls an allowed tool", async () => {
    const upstreams = await postJson("/exec/mcp", {
      args: [],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const upstreamBody = (await upstreams.json()) as { stdout: string };

    expect(upstreams.status).toBe(200);
    expect(JSON.parse(upstreamBody.stdout)).toEqual({
      upstreams: [
        { name: "atlassian", toolCount: 0, connected: false },
        { name: "grafana", toolCount: 0, connected: false },
        { name: "posthog", toolCount: 0, connected: false },
      ],
    });

    const listedTools = await postJson("/exec/mcp", {
      args: ["atlassian"],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const toolsBody = (await listedTools.json()) as { stdout: string };

    expect(listedTools.status).toBe(200);
    expect(toolsBody.stdout.trim().split("\n")).toEqual([
      "getJiraIssue",
      "createJiraIssue",
      "createIssueLink",
    ]);

    const hiddenLookup = await postJson("/exec/mcp", {
      args: [
        "atlassian",
        "lookupJiraAccountId",
        '{"cloudId":"cloud-1","searchString":"alice@example.com"}',
      ],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const hiddenLookupBody = (await hiddenLookup.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(hiddenLookup.status).toBe(200);
    expect(hiddenLookupBody.exitCode).toBe(1);
    expect(hiddenLookupBody.stderr).toContain('Unknown tool "lookupJiraAccountId"');

    const call = await postJson("/exec/mcp", {
      args: ["atlassian", "getJiraIssue", "{}"],
      cwd: "/workspace/worktrees/acme/feature-branch",
      directory: "/workspace/repos/acme",
    });
    const callBody = (await call.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(call.status).toBe(200);
    expect(callBody).toMatchObject({
      stdout: "THOR-123",
      stderr: "",
      exitCode: 0,
    });
    expect(toolCalls).toEqual([{ name: "getJiraIssue", arguments: {} }]);

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as {
      mcp: { configured: number; instances: { atlassian: { connected: boolean; tools: number } } };
    };

    expect(health.status).toBe(200);
    expect(healthBody.mcp.configured).toBe(3);
    expect(healthBody.mcp.instances.atlassian).toEqual({ connected: true, tools: 5 });
  });

  it("warms every registered upstream", async () => {
    await closeRemoteCli();

    const remoteCli = createRemoteCliApp({
      mcp: {
        approvalsDir,
        isProduction: true,
        writeToolCallLogFn: (entry) => {
          toolCallLogEntries.push(entry as unknown as Record<string, unknown>);
        },
        connectUpstreamFn: async (name: string): Promise<UpstreamConnection> => {
          connectedUpstreams.push(name);
          return {
            tools,
            client: {
              callTool: async () => ({ content: [] }),
              close: async () => {},
            } as unknown as UpstreamConnection["client"],
          };
        },
      },
    });

    closeRemoteCli = remoteCli.close;
    await remoteCli.warmUp();

    expect(connectedUpstreams.sort()).toEqual(["atlassian", "grafana", "posthog"]);
  });

  it("rejects worktree session directories for MCP authz", async () => {
    const response = await postJson("/exec/mcp", {
      args: [],
      cwd: "/workspace/worktrees/acme/feature-branch",
      directory: "/workspace/worktrees/acme/feature-branch",
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      stdout: "",
      stderr:
        "Cannot determine repo from directory: /workspace/worktrees/acme/feature-branch. Expected /workspace/repos/<repo> (worktrees are not allowed for MCP authz)",
      exitCode: 1,
    });
  });

  it("fails closed for Jira approvals when Thor session context is missing", async () => {
    const pending = await postJson("/exec/mcp", {
      args: [
        "atlassian",
        "createJiraIssue",
        '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
      ],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(pendingBody.stderr).toContain("missing Thor session id");
    expect(toolCalls).toEqual([]);

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(JSON.parse(listBody.stdout)).toEqual({ approvals: [] });
  });

  it("rejects invalid approval args before persisting an action", async () => {
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(pendingBody.stderr).toContain('Invalid approval arguments for "createJiraIssue"');
    expect(pendingBody.stderr).toContain("issueTypeName");
    expect(toolCalls).toEqual([]);

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(JSON.parse(listBody.stdout)).toEqual({ approvals: [] });
  });

  it("creates approvals with Jira disclaimers, exposes them via approval commands, and returns 401 for resolve without the internal secret", async () => {
    appendActiveTrigger();
    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };

    expect(pending.status).toBe(200);
    expect(toolCalls).toEqual([]);

    const approvalOutput = JSON.parse(pendingBody.stdout) as {
      type: string;
      actionId: string;
      proxyName: string;
      tool: string;
      args: Record<string, unknown>;
      command: string;
    };
    const cleanArgs = {
      cloudId: "cloud-1",
      projectKey: "THOR",
      issueTypeName: "Task",
      summary: "Fix it",
      description: "body",
    };
    const upstreamArgs = {
      ...cleanArgs,
      description: `body\n${formatThorContextFooter(`https://thor.example.com/runner/v/${activeAnchorId}/${activeTriggerId}`)}`,
    };
    expect(approvalOutput).toMatchObject({
      type: "approval_required",
      proxyName: "atlassian",
      tool: "createJiraIssue",
      args: cleanArgs,
    });
    expect(approvalOutput.command).toBe(`approval status ${approvalOutput.actionId}`);
    const actionId = approvalOutput.actionId;

    const status = await postJson("/exec/approval", {
      args: ["status", actionId],
    });
    const statusBody = (await status.json()) as { stdout: string };
    expect(status.status).toBe(200);
    expect(JSON.parse(statusBody.stdout)).toMatchObject({
      id: actionId,
      upstream: "atlassian",
      status: "pending",
      tool: "createJiraIssue",
      args: cleanArgs,
      origin: {
        sessionId: "parent-session",
        trigger: { anchorId: activeAnchorId, triggerId: activeTriggerId },
      },
      notification: {
        provider: "slack",
        channel: "C123",
        threadTs: "1710000000.001",
        messageTs: "1710000000.100",
      },
    });
    expect(slackFetch).toHaveBeenCalledWith(
      "https://slack.test/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(list.status).toBe(200);
    expect(JSON.parse(listBody.stdout)).toMatchObject({
      approvals: [
        expect.objectContaining({ id: actionId, upstream: "atlassian", status: "pending" }),
      ],
    });

    const deniedResolve = await postJson("/exec/mcp", {
      args: ["resolve", actionId, "approved", "U123"],
    });
    expect(deniedResolve.status).toBe(401);

    const wrongSecretResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "wrong" },
    );
    expect(wrongSecretResolve.status).toBe(401);

    const allowedResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const allowedBody = (await allowedResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(allowedResolve.status).toBe(200);
    expect(allowedBody).toMatchObject({
      stdout: "created",
      stderr: "",
      exitCode: 0,
    });
    expect(toolCalls).toEqual([
      {
        name: "createJiraIssue",
        arguments: upstreamArgs,
      },
    ]);
  });

  it("calls Jira issue-link creation directly without approval", async () => {
    appendActiveTrigger();
    const cleanArgs = {
      cloudId: "cloud-1",
      outwardIssueIdOrKey: "THOR-1",
      inwardIssueIdOrKey: "THOR-2",
      linkType: "blocks",
      comment: "Implementation ticket for the product work.",
    };

    const pending = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "createIssueLink", JSON.stringify(cleanArgs)],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody).toEqual({ stdout: "linked", stderr: "", exitCode: 0 });
    expect(toolCalls).toEqual([{ name: "createIssueLink", arguments: cleanArgs }]);
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("posts approval cards to the trigger Slack thread when the anchor has other Slack aliases", async () => {
    appendActiveTrigger();
    appendAlias({
      aliasType: "slack.thread",
      aliasValue: "C999/1710000000.999",
      anchorId: activeAnchorId,
    });

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string; exitCode: number };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(0);
    expect(JSON.parse(pendingBody.stdout)).toMatchObject({
      type: "approval_required",
      proxyName: "atlassian",
      tool: "createJiraIssue",
    });

    expect(slackFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body)) as {
      channel: string;
      thread_ts?: string;
    };
    expect(payload).toMatchObject({
      channel: "C123",
      thread_ts: "1710000000.001",
    });
  });

  it("falls back to the newest Slack trigger when the latest trigger is GitHub", async () => {
    appendActiveTrigger({ ts: "2026-05-21T00:00:01.000Z" });
    appendSessionEvent("parent-session", {
      type: "trigger_end",
      triggerId: activeTriggerId,
      status: "completed",
      ts: "2026-05-21T00:00:02.000Z",
    });
    appendSessionEvent("parent-session", {
      type: "trigger_start",
      triggerId: githubTriggerId,
      correlationKey: "github:issue:acme:acme/repo#42",
      triggerGithubLogin: "octocat",
      ts: "2026-05-21T00:00:03.000Z",
    });

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string; exitCode: number };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(0);
    expect(JSON.parse(pendingBody.stdout)).toMatchObject({
      type: "approval_required",
      proxyName: "atlassian",
      tool: "createJiraIssue",
    });

    expect(slackFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body)) as {
      channel: string;
      thread_ts?: string;
    };
    expect(payload).toMatchObject({
      channel: "C123",
      thread_ts: "1710000000.001",
    });
  });

  it("fails closed when an approval origin cannot resolve to a Slack thread", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "session-without-slack-thread",
      anchorId: "00000000-0000-7000-8000-0000000004a2",
    });
    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "session-without-slack-thread" },
    );
    const pendingBody = (await pending.json()) as { stderr: string; exitCode: number };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(1);
    expect(pendingBody.stderr).toContain("has no Slack trigger correlation key");
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("fails closed when an approval origin only has a legacy Slack thread alias", async () => {
    const legacyAnchorId = "00000000-0000-7000-8000-0000000004a3";
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "legacy-thread-session",
      anchorId: legacyAnchorId,
    });
    appendAlias({
      aliasType: "slack.thread_id",
      aliasValue: "1710000000.001",
      anchorId: legacyAnchorId,
    });
    appendSessionEvent("legacy-thread-session", {
      type: "trigger_start",
      triggerId: activeTriggerId,
      correlationKey: "slack:thread:1710000000.001",
    });

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "legacy-thread-session" },
    );
    const pendingBody = (await pending.json()) as { stderr: string; exitCode: number };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(1);
    expect(pendingBody.stderr).toContain("unsupported Slack thread correlation key");
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("fails closed when posting the approval card to Slack fails", async () => {
    slackFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" })),
    );
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(1);
    expect(pendingBody.stdout).toBe("");
    expect(pendingBody.stderr).toContain("Slack API error: channel_not_found");

    const dateDir = readdirSync(join(approvalsDir, "atlassian"))[0]!;
    const actionFile = readdirSync(join(approvalsDir, "atlassian", dateDir))[0]!;
    const storedAction = JSON.parse(
      readFileSync(join(approvalsDir, "atlassian", dateDir, actionFile), "utf-8"),
    ) as { id: string; status: string; reason?: string };
    expect(storedAction).toMatchObject({
      status: "rejected",
      reason: "Slack API error: channel_not_found",
    });

    const resolveRejectedZombie = await postJson(
      "/exec/mcp",
      { args: ["resolve", storedAction.id, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolveRejectedZombieBody = (await resolveRejectedZombie.json()) as {
      stderr: string;
      exitCode: number;
    };
    expect(resolveRejectedZombieBody.exitCode).toBe(1);
    expect(resolveRejectedZombieBody.stderr).toContain(
      "is already rejected; cannot resolve as approved",
    );

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(JSON.parse(listBody.stdout)).toEqual({ approvals: [] });
  });

  it("injects Jira assignee during approved issue creation", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(jiraLookups).toEqual([{ cloudId: "cloud-1", searchString: "alice@example.com" }]);
    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments).toMatchObject({
      description: `body\n${formatThorContextFooter(`https://thor.example.com/runner/v/${activeAnchorId}/${activeTriggerId}`)}`,
      assignee_account_id: "jira-account-1",
    });
    expect(toolCalls[1].arguments?.additional_fields).toBeUndefined();
  });

  it("preserves Jira additional fields when injecting assignee", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","additional_fields":{"labels":["thor"],"priority":{"name":"High"}}}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.additional_fields).toEqual({
      labels: ["thor"],
      priority: { name: "High" },
    });
    expect(toolCalls[1].arguments?.assignee_account_id).toBe("jira-account-1");
  });

  it("does not overwrite existing Jira assignee account id", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","assignee_account_id":"existing"}',
    );

    expect(jiraLookups).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments?.assignee_account_id).toBe("existing");
  });

  it("keeps Jira issue creation best-effort when account lookup returns multiple matches", async () => {
    jiraLookupResultText = JSON.stringify(
      jiraLookupResponse([{ accountId: "jira-account-1" }, { accountId: "jira-account-2" }]),
    );
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.assignee_account_id).toBeUndefined();
  });

  it("keeps Jira issue creation best-effort when account lookup throws", async () => {
    jiraLookupFailure = new Error("lookup exploded");
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.assignee_account_id).toBeUndefined();
  });

  it("keeps Jira issue creation best-effort when cloudId is missing", async () => {
    await approveJiraCreate(
      '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(jiraLookups).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments?.assignee_account_id).toBeUndefined();
  });

  it("blocks Jira approvals when contentFormat is not markdown", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendActiveTrigger();
    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","contentFormat":"adf"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(pendingBody.stderr).toContain('"createJiraIssue" is not allowed.');
    expect(pendingBody.stderr).toContain('contentFormat "adf" is not supported');
    expect(toolCalls).toEqual([]);

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(JSON.parse(listBody.stdout)).toEqual({ approvals: [] });
  });

  it("deduplicates concurrent same-decision approval resolves in one process", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendActiveTrigger();
    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    let releaseCall!: () => void;
    createJiraIssueDelay = new Promise((resolve) => {
      releaseCall = resolve;
    });

    const firstResolve = postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const secondResolve = postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    await vi.waitFor(() => expect(toolCalls).toHaveLength(1));
    releaseCall();

    const [first, second] = await Promise.all([firstResolve, secondResolve]);
    const firstBody = (await first.json()) as { stdout: string; stderr: string; exitCode: number };
    const secondBody = (await second.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(firstBody).toEqual({
      stdout: "created",
      stderr: "",
      exitCode: 0,
      sideEffectAttempted: true,
    });
    expect(secondBody).toEqual(firstBody);
    expect(toolCalls).toHaveLength(1);

    const laterResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const laterBody = (await laterResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(laterBody).toEqual(firstBody);
    expect(toolCalls).toHaveLength(1);
  });

  it("rejects concurrent same-decision approval resolves from different reviewers", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendActiveTrigger();
    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    let releaseCall!: () => void;
    createJiraIssueDelay = new Promise((resolve) => {
      releaseCall = resolve;
    });

    const firstResolve = postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    await vi.waitFor(() => expect(toolCalls).toHaveLength(1));

    const secondResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U999"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const secondBody = (await secondResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(secondBody.exitCode).toBe(1);
    expect(secondBody.stderr).toContain(
      `Approval action ${actionId} is already resolving for reviewer U123; cannot also resolve as U999`,
    );

    releaseCall();
    const firstBody = (await (await firstResolve).json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(firstBody).toEqual({
      stdout: "created",
      stderr: "",
      exitCode: 0,
      sideEffectAttempted: true,
    });
    expect(toolCalls).toHaveLength(1);
  });

  it("keeps approvals pending when approved tool execution fails and returns a clear error for corrupt approved records", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    createJiraIssueFailure = new Error("upstream unavailable");
    const failedResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const failedBody = (await failedResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      sideEffectAttempted?: boolean;
    };
    expect(failedBody.exitCode).toBe(1);
    expect(failedBody.stderr).toContain("upstream unavailable");
    expect(failedBody.sideEffectAttempted).toBe(true);

    const statusAfterFailure = await postJson("/exec/approval", { args: ["status", actionId] });
    const statusAfterFailureBody = (await statusAfterFailure.json()) as { stdout: string };
    expect(JSON.parse(statusAfterFailureBody.stdout)).toMatchObject({
      id: actionId,
      status: "pending",
      error: "upstream unavailable",
    });

    const successfulRetry = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const successfulRetryBody = (await successfulRetry.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(successfulRetryBody).toEqual({
      stdout: "created",
      stderr: "",
      exitCode: 0,
      sideEffectAttempted: true,
    });

    const statusAfterSuccess = await postJson("/exec/approval", { args: ["status", actionId] });
    const statusAfterSuccessBody = (await statusAfterSuccess.json()) as { stdout: string };
    const storedAction = JSON.parse(statusAfterSuccessBody.stdout) as Record<string, unknown>;
    const dateSegment = String(storedAction.dateSegment);
    writeFileSync(
      join(approvalsDir, "atlassian", dateSegment, `${actionId}.json`),
      JSON.stringify({ ...storedAction, result: undefined }, null, 2),
    );

    const corruptResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const corruptResolveBody = (await corruptResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(corruptResolve.status).toBe(200);
    expect(corruptResolveBody.exitCode).toBe(1);
    expect(corruptResolveBody.stderr).toContain(`Failed to load approval action ${actionId}`);
    expect(corruptResolveBody.stderr).toContain(
      "approved approval actions must include a valid ExecResult result",
    );

    const corruptStatus = await postJson("/exec/approval", { args: ["status", actionId] });
    const corruptStatusBody = (await corruptStatus.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(corruptStatus.status).toBe(200);
    expect(corruptStatusBody.exitCode).toBe(1);
    expect(corruptStatusBody.stderr).toContain(`Failed to load approval action ${actionId}`);
  });

  it("surfaces MCP CallToolResult.isError as a side-effect-attempted failure on approved resolution", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    // triggerSlackId lets resolveTriggerUser map the trigger to the configured
    // user (alice@example.com) so withJiraAttribution actually runs and the
    // worklog assertion below has something to verify.
    appendActiveTrigger({ triggerSlackId: "UABCDEF1" });

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
        ],
        cwd: "/workspace/repos/acme",
        directory: "/workspace/repos/acme",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    createJiraIssueErrorResponse = "The target project doesn't exist or you don't have permission.";
    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolvedBody = (await resolved.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      sideEffectAttempted?: boolean;
    };
    expect(resolvedBody.exitCode).toBe(1);
    expect(resolvedBody.sideEffectAttempted).toBe(true);
    expect(resolvedBody.stderr).toContain("The target project doesn't exist");

    const statusAfterFailure = await postJson("/exec/approval", { args: ["status", actionId] });
    const statusAfterFailureBody = (await statusAfterFailure.json()) as { stdout: string };
    expect(JSON.parse(statusAfterFailureBody.stdout)).toMatchObject({
      id: actionId,
      status: "pending",
    });

    // The worklog must reflect the args actually sent to the upstream
    // (post-attribution), not the pre-attribution args from the approval
    // store — auditors rely on the worklog to see assignee_account_id, etc.
    const createEntry = toolCallLogEntries.find(
      (entry) =>
        entry.tool === "createJiraIssue" &&
        entry.decision === "approved" &&
        typeof entry.error === "string",
    );
    expect(createEntry).toBeDefined();
    expect((createEntry!.args as Record<string, unknown>).assignee_account_id).toBe(
      "jira-account-1",
    );
  });

  it("returns 401 for /internal/exec without the internal secret", async () => {
    const response = await postJson("/internal/exec", {
      bin: "echo",
      args: ["hello"],
      cwd: "/tmp",
    });
    expect(response.status).toBe(401);
  });

  it("runs /internal/exec with valid internal secret", async () => {
    const response = await postJson(
      "/internal/exec",
      {
        bin: "echo",
        args: ["hello"],
        cwd: "/tmp",
      },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(0);
    expect(body.stdout.trim()).toBe("hello");
    expect(body.stderr).toBe("");
  });

  async function postJson(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
});
