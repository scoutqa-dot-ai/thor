import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appendAlias, appendSessionEvent, formatThorContextFooter } from "@thor/common";
import type { WorkspaceConfig } from "@thor/common";
import type { ToolCallLogEntry } from "@thor/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteCliApp } from "./index.ts";
import type { UpstreamConnection } from "./upstream.ts";

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
  let connectedUpstreams: string[];
  let upstreamConfigs: Array<{ name: string; headers?: Record<string, string> }>;
  let closeRemoteCli: () => Promise<void>;
  let jiraLookups: Array<Record<string, unknown> | undefined>;
  let jiraLookupResultText: string;
  let jiraLookupFailure: Error | undefined;
  let slackFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let workspaceConfig: WorkspaceConfig;
  let configLoadFailure: Error | undefined;
  let upstreamConnectFailure: Error | undefined;
  let toolCallLogs: ToolCallLogEntry[];

  beforeEach(async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic dGVzdA==");
    vi.stubEnv("POSTHOG_API_KEY", "test-posthog-key");
    vi.stubEnv("GRAFANA_URL", "https://grafana.example.com");
    vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "grafana-token");
    vi.stubEnv("THOR_INTERNAL_SECRET", "resolve-secret");
    vi.stubEnv("WORKLOG_DIR", worklogDir);
    vi.stubEnv("RUNNER_BASE_URL", "https://thor.example.com/");
    rmSync("/tmp/thor-remote-cli-mcp-test", { recursive: true, force: true });
    approvalsDir = mkdtempSync(join(tmpdir(), "remote-cli-mcp-"));
    toolCalls = [];
    createJiraIssueDelay = undefined;
    createJiraIssueFailure = undefined;
    connectedUpstreams = [];
    upstreamConfigs = [];
    jiraLookups = [];
    jiraLookupResultText = JSON.stringify(jiraLookupResponse([{ accountId: "jira-account-1" }]));
    jiraLookupFailure = undefined;
    configLoadFailure = undefined;
    upstreamConnectFailure = undefined;
    toolCallLogs = [];
    slackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1710000000.100" })),
      );
    workspaceConfig = {
      users: [{ email: "alice@example.com", name: "Alice", slack: "UABCDEF1", github: "alice" }],
    };
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

    await startRemoteCliServer();
  });

  async function startRemoteCliServer(): Promise<void> {
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
          toolCallLogs.push(entry);
        },
        configLoader: () => {
          if (configLoadFailure) throw configLoadFailure;
          return workspaceConfig;
        },
        connectUpstreamFn: async (
          name: string,
          upstreamConfig: { headers?: Record<string, string> },
        ): Promise<UpstreamConnection> => {
          if (upstreamConnectFailure) throw upstreamConnectFailure;
          connectedUpstreams.push(name);
          upstreamConfigs.push({ name, headers: upstreamConfig.headers });
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
  }

  async function stopRemoteCliServer(): Promise<void> {
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
  }

  afterEach(async () => {
    await stopRemoteCliServer();
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
    const upstreams = await postJson(
      "/exec/mcp",
      {
        args: [],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const upstreamBody = (await upstreams.json()) as { stdout: string };

    expect(upstreams.status).toBe(200);
    expect(upstreamBody.stdout.trim().split("\n")).toEqual(["atlassian", "grafana", "posthog"]);

    const listedTools = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const toolsBody = (await listedTools.json()) as { stdout: string };

    expect(listedTools.status).toBe(200);
    expect(toolsBody.stdout.trim().split("\n")).toEqual([
      "getJiraIssue",
      "createJiraIssue",
      "createIssueLink",
    ]);

    const hiddenLookup = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "lookupJiraAccountId",
          '{"cloudId":"cloud-1","searchString":"alice@example.com"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const hiddenLookupBody = (await hiddenLookup.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(hiddenLookup.status).toBe(200);
    expect(hiddenLookupBody.exitCode).toBe(1);
    expect(hiddenLookupBody.stderr).toContain('Unknown tool "lookupJiraAccountId"');

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
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
    expect(toolCallLogs).toContainEqual(
      expect.objectContaining({
        tool: "getJiraIssue",
        decision: "allowed",
        targetKey: "atlassian:GLOBAL",
        profile: undefined,
      }),
    );

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as {
      mcp: {
        configured: number;
        connected: number;
        connectedTargets: number;
        instances: { atlassian: { connected: boolean; tools: number } };
      };
    };

    expect(health.status).toBe(200);
    expect(healthBody.mcp.configured).toBe(3);
    expect(healthBody.mcp.connected).toBe(1);
    expect(healthBody.mcp.connectedTargets).toBe(1);
    expect(healthBody.mcp.instances.atlassian).toEqual({ connected: true, tools: 5 });
  });

  it("fails live MCP calls when profile config cannot be loaded", async () => {
    configLoadFailure = new Error("workspace config unavailable");

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(call.status).toBe(200);
    expect(body).toMatchObject({ stdout: "", exitCode: 1 });
    expect(body.stderr).toContain("workspace config unavailable");
    expect(connectedUpstreams).toEqual([]);
    expect(toolCalls).toEqual([]);
  });

  it("passes through profile-scoped integration config errors while listing upstreams", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY_QA", "pk-qa");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };
    appendActiveTrigger();

    const call = await postJson(
      "/exec/mcp",
      { args: ["--help"] },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(call.status).toBe(200);
    expect(body).toMatchObject({ stdout: "", exitCode: 1 });
    expect(body.stderr).toContain('partial langfuse profile bundle for "QA"');
    expect(body.stderr).toContain("LANGFUSE_SECRET_KEY_QA");
    expect(body.stderr).not.toContain("Integration not available in this thread context");
  });

  it("warms every registered upstream", async () => {
    await closeRemoteCli();

    const remoteCli = createRemoteCliApp({
      mcp: {
        approvalsDir,
        isProduction: true,
        writeToolCallLogFn: () => {},
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

  it("routes Slack-triggered MCP calls through the channel profile credential target", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: { QA: { channels: ["C123"] } },
    };
    appendActiveTrigger();

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as { stdout: string; exitCode: number };

    expect(body).toMatchObject({ stdout: "THOR-123", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-token",
    });
    expect(toolCallLogs).toContainEqual(
      expect.objectContaining({
        tool: "getJiraIssue",
        decision: "allowed",
        targetKey: "atlassian:QA",
        profile: "QA",
      }),
    );
  });

  it("logs the resolved profile even when a profiled session falls back to global credentials", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "");
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: { QA: { channels: ["C123"] } },
    };
    appendActiveTrigger();

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as { stdout: string; exitCode: number };

    expect(body).toMatchObject({ stdout: "THOR-123", exitCode: 0 });
    expect(toolCallLogs).toContainEqual(
      expect.objectContaining({
        tool: "getJiraIssue",
        decision: "allowed",
        targetKey: "atlassian:GLOBAL",
        profile: "QA",
      }),
    );
  });

  it("honors the Slack channel's profile even after a subsequent non-Slack trigger fires", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };
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

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as { stdout: string; exitCode: number };

    // The Slack alias on the anchor pins the profile to QA for the lifetime of
    // the anchor. A newer non-Slack trigger does not flip credentials back to
    // globals — once a session is in a profile, all its MCP calls go through
    // that profile.
    expect(body).toMatchObject({ stdout: "THOR-123", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-token",
    });
  });

  it("does not store profile/routing snapshot on approval actions", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    const status = await postJson("/exec/approval", { args: ["status", actionId] });
    const stored = JSON.parse(((await status.json()) as { stdout: string }).stdout) as Record<
      string,
      unknown
    >;
    expect(stored).not.toHaveProperty("routing");
  });

  it("re-resolves approval routing at click time using fresh env and config", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "");
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-before-approval");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-after-approval");
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-after-approval");
    await stopRemoteCliServer();
    upstreamConfigs = [];
    await startRemoteCliServer();
    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolvedBody = (await resolved.json()) as { stdout: string; exitCode: number };

    // Channel C123 maps to QA, and ATLASSIAN_AUTH_QA is now set, so the
    // approval should fire against the freshly resolved profile credential,
    // not the global fallback that was active when the approval card was
    // posted.
    expect(resolvedBody).toMatchObject({ stdout: "created", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-after-approval",
    });
  });

  it("passes through approval-time upstream connection failures", async () => {
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    await stopRemoteCliServer();
    upstreamConnectFailure = new Error("atlassian upstream TLS failed at /workspace/certs/ca.pem");
    await startRemoteCliServer();

    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolvedBody = (await resolved.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(resolvedBody.exitCode).toBe(1);
    expect(resolvedBody.stderr).toBe("atlassian upstream TLS failed at /workspace/certs/ca.pem");

    const rejected = JSON.parse(resolvedBody.stdout) as { status: string; reason?: string };
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toContain("atlassian upstream TLS failed at /workspace/certs/ca.pem");
    expect(rejected.reason).not.toContain("Integration not available in this thread context");
  });

  it("rejects an approval when its stored session id no longer resolves to an anchor", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    const status = await postJson("/exec/approval", { args: ["status", actionId] });
    const stored = JSON.parse(((await status.json()) as { stdout: string }).stdout) as Record<
      string,
      unknown
    >;
    const dateSegment = String(stored.dateSegment);
    writeFileSync(
      join(approvalsDir, "atlassian", dateSegment, `${actionId}.json`),
      JSON.stringify(
        {
          ...stored,
          origin: { ...(stored.origin as Record<string, unknown>), sessionId: "stale-session" },
        },
        null,
        2,
      ),
    );

    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolvedBody = (await resolved.json()) as { exitCode: number; stderr: string };

    expect(resolvedBody.exitCode).toBe(1);
    expect(resolvedBody.stderr).toBe("Integration not available in this thread context");
    expect(toolCalls).toEqual([]);

    const rejectedStatus = await postJson("/exec/approval", { args: ["status", actionId] });
    const rejected = JSON.parse(((await rejectedStatus.json()) as { stdout: string }).stdout) as {
      status: string;
      reviewer?: string;
      reason?: string;
    };
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewer).toBe("system");
    expect(rejected.reason).toMatch(/profile re-resolution failed/);
    expect(rejected.reason).toContain("Integration not available in this thread context");
  });

  it("rejects an approval when the session's channels are bound to multiple profiles", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    vi.stubEnv("ATLASSIAN_AUTH_LABS", "Basic labs-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: { QA: { channels: ["C123"] }, LABS: { channels: ["C456"] } },
    };
    appendActiveTrigger();

    const pending = await postJson(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "createJiraIssue",
          '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it"}',
        ],
      },
      { "x-thor-session-id": "parent-session" },
    );
    const pendingBody = (await pending.json()) as { stdout: string };
    const actionId = (JSON.parse(pendingBody.stdout) as { actionId: string }).actionId;

    // Bind a second Slack thread on the same anchor in a different profile.
    appendAlias({
      aliasType: "slack.thread",
      aliasValue: "C456/1710000099.001",
      anchorId: activeAnchorId,
    });

    const resolved = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const resolvedBody = (await resolved.json()) as { exitCode: number; stderr: string };
    expect(resolvedBody.exitCode).toBe(1);
    expect(resolvedBody.stderr).toBe("Integration not available in this thread context");

    const status = await postJson("/exec/approval", { args: ["status", actionId] });
    const stored = JSON.parse(((await status.json()) as { stdout: string }).stdout) as {
      status: string;
      reviewer?: string;
      reason?: string;
    };
    expect(stored.status).toBe("rejected");
    expect(stored.reviewer).toBe("system");
    expect(stored.reason).toMatch(/profile re-resolution failed/);
    expect(stored.reason).toContain("Integration not available in this thread context");
  });

  it("counts profile-only upstreams in health configured total", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "");
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.stubEnv("GRAFANA_URL", "");
    vi.stubEnv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = { ...workspaceConfig, profiles: { QA: { channels: ["C123"] } } };

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as { mcp: { configured: number } };

    expect(health.status).toBe(200);
    expect(healthBody.mcp.configured).toBe(1);
  });

  it("reports connected upstream names separately from connected credential targets in health", async () => {
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    vi.stubEnv("ATLASSIAN_AUTH_LABS", "Basic labs-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: { QA: { channels: ["C123"] }, LABS: { channels: ["C999"] } },
    };

    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "labs-session",
      anchorId: "00000000-0000-7000-8000-0000000004b1",
    });
    appendAlias({
      aliasType: "slack.thread",
      aliasValue: "C999/1710000000.002",
      anchorId: "00000000-0000-7000-8000-0000000004b1",
    });
    appendSessionEvent("labs-session", {
      type: "trigger_start",
      triggerId: "00000000-0000-7000-8000-000000000103",
      correlationKey: "slack:thread:C999/1710000000.002",
    });

    await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "parent-session" },
    );
    await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "labs-session" },
    );

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as {
      mcp: { configured: number; connected: number; connectedTargets: number };
    };

    expect(health.status).toBe(200);
    expect(healthBody.mcp.configured).toBeGreaterThanOrEqual(1);
    expect(healthBody.mcp.connected).toBe(1);
    expect(healthBody.mcp.connectedTargets).toBe(2);
  });

  it("uses the session repo alias instead of a forged request directory for profile routing", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    vi.stubEnv("ATLASSIAN_AUTH_LABS", "Basic labs-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: {
        QA: { repos: ["repo-qa"] },
        LABS: { repos: ["repo-labs"] },
      },
    };
    appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: activeAnchorId });

    const call = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
        directory: "/workspace/repos/repo-labs",
      },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(call.status).toBe(200);
    expect(body).toMatchObject({ stdout: "THOR-123", stderr: "", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-token",
    });
  });

  it("allows a Slack session to use a mixed profile when its channel is in the profile", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: {
        QA: { channels: ["C123"], repos: ["repo-qa"] },
      },
    };
    appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: activeAnchorId });

    const call = await postJson(
      "/exec/mcp",
      { args: ["atlassian", "getJiraIssue", "{}"] },
      { "x-thor-session-id": "parent-session" },
    );
    const body = (await call.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(call.status).toBe(200);
    expect(body).toMatchObject({ stdout: "THOR-123", stderr: "", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-token",
    });
  });

  it("blocks an unlisted Slack session from adopting a mixed channel+repo profile", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: {
        QA: { channels: ["C123"], repos: ["repo-qa"] },
      },
    };
    const unlistedAnchorId = "00000000-0000-7000-8000-0000000004c1";
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "unlisted-session",
      anchorId: unlistedAnchorId,
    });
    appendAlias({
      aliasType: "slack.thread",
      aliasValue: "C999/1710000000.001",
      anchorId: unlistedAnchorId,
    });
    appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: unlistedAnchorId });

    const call = await postJson(
      "/exec/mcp",
      { args: ["atlassian", "getJiraIssue", "{}"] },
      { "x-thor-session-id": "unlisted-session" },
    );
    const body = (await call.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(call.status).toBe(200);
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toBe("Integration not available in this thread context");
    expect(toolCalls).toEqual([]);
  });

  it("allows a non-Slack session to use a mixed profile through its repo alias", async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic global-token");
    vi.stubEnv("ATLASSIAN_AUTH_QA", "Basic qa-token");
    workspaceConfig = {
      ...workspaceConfig,
      profiles: {
        QA: { channels: ["C123"], repos: ["repo-qa"] },
      },
    };
    const repoAnchorId = "00000000-0000-7000-8000-0000000004d1";
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "repo-session",
      anchorId: repoAnchorId,
    });
    appendAlias({ aliasType: "repo", aliasValue: "repo-qa", anchorId: repoAnchorId });

    const call = await postJson(
      "/exec/mcp",
      { args: ["atlassian", "getJiraIssue", "{}"] },
      { "x-thor-session-id": "repo-session" },
    );
    const body = (await call.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(call.status).toBe(200);
    expect(body).toMatchObject({ stdout: "THOR-123", stderr: "", exitCode: 0 });
    expect(upstreamConfigs.find((config) => config.name === "atlassian")?.headers).toEqual({
      Authorization: "Basic qa-token",
    });
  });

  it("fails closed for MCP calls when Thor session context is missing", async () => {
    const allowed = await postJson("/exec/mcp", {
      args: ["atlassian", "getJiraIssue", "{}"],
    });
    const allowedBody = (await allowed.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(allowed.status).toBe(200);
    expect(allowedBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(allowedBody.stderr).toBe("Integration not available in this thread context");
    expect(toolCalls).toEqual([]);

    const fakeSession = await postJson(
      "/exec/mcp",
      {
        args: ["atlassian", "getJiraIssue", "{}"],
      },
      { "x-thor-session-id": "fake-session" },
    );
    const fakeSessionBody = (await fakeSession.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(fakeSession.status).toBe(200);
    expect(fakeSessionBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(fakeSessionBody.stderr).toBe("Integration not available in this thread context");
    expect(toolCalls).toEqual([]);

    const pending = await postJson("/exec/mcp", {
      args: [
        "atlassian",
        "createJiraIssue",
        '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
      ],
    });
    const pendingBody = (await pending.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(pending.status).toBe(200);
    expect(pendingBody).toMatchObject({ stdout: "", exitCode: 1 });
    expect(pendingBody.stderr).toBe("Integration not available in this thread context");
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
      },
      { "x-thor-session-id": "session-without-slack-thread" },
    );
    const pendingBody = (await pending.json()) as { stderr: string; exitCode: number };

    expect(pending.status).toBe(200);
    expect(pendingBody.exitCode).toBe(1);
    expect(pendingBody.stderr).toContain("has no Slack trigger correlation key");
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

    expect(firstBody).toEqual({ stdout: "created", stderr: "", exitCode: 0 });
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
    expect(firstBody).toEqual({ stdout: "created", stderr: "", exitCode: 0 });
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
    };
    expect(failedBody.exitCode).toBe(1);
    expect(failedBody.stderr).toContain('Error calling "createJiraIssue": upstream unavailable');

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
    expect(successfulRetryBody).toEqual({ stdout: "created", stderr: "", exitCode: 0 });

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
