import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const activeAnchorId = "00000000-0000-7000-8000-0000000004a1";

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

describe("remote-cli MCP endpoints", () => {
  let approvalsDir: string;
  let server: Server;
  let baseUrl: string;
  let toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  let createJiraIssueDelay: Promise<void> | undefined;
  let createJiraIssueFailure: Error | undefined;
  let connectedUpstreams: string[];
  let closeRemoteCli: () => Promise<void>;
  let jiraLookups: Array<Record<string, unknown> | undefined>;
  let jiraLookupResultText: string;
  let jiraLookupFailure: Error | undefined;

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
    connectedUpstreams = [];
    jiraLookups = [];
    jiraLookupResultText = JSON.stringify(jiraLookupResponse([{ accountId: "jira-account-1" }]));
    jiraLookupFailure = undefined;

    const remoteCli = createRemoteCliApp({
      mcp: {
        approvalsDir,
        isProduction: true,
        writeToolCallLogFn: () => {},
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
                  return {
                    content: [{ type: "text", text: "created" }],
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
    expect(toolsBody.stdout.trim().split("\n")).toEqual(["getJiraIssue", "createJiraIssue"]);

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
    expect(healthBody.mcp.instances.atlassian).toEqual({ connected: true, tools: 4 });
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
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });

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
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });
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
    });

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

  it("injects Jira reporter during approved issue creation", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(jiraLookups).toEqual([{ cloudId: "cloud-1", searchString: "alice@example.com" }]);
    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments).toMatchObject({
      description: `body\n${formatThorContextFooter(`https://thor.example.com/runner/v/${activeAnchorId}/${activeTriggerId}`)}`,
      additional_fields: { reporter: { id: "jira-account-1" } },
    });
    expect(toolCalls[1].arguments?.assignee_account_id).toBeUndefined();
  });

  it("merges Jira reporter into existing additional fields", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","additional_fields":{"labels":["thor"],"priority":{"name":"High"}}}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.additional_fields).toEqual({
      labels: ["thor"],
      priority: { name: "High" },
      reporter: { id: "jira-account-1" },
    });
  });

  it("does not overwrite existing Jira reporter", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","additional_fields":{"reporter":{"id":"existing"},"labels":["thor"]}}',
    );

    expect(jiraLookups).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments?.additional_fields).toEqual({
      reporter: { id: "existing" },
      labels: ["thor"],
    });
  });

  it("does not clobber malformed Jira additional fields", async () => {
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body","additional_fields":"bad-shape"}',
    );

    expect(jiraLookups).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments?.additional_fields).toBe("bad-shape");
  });

  it("keeps Jira issue creation best-effort when account lookup returns multiple matches", async () => {
    jiraLookupResultText = JSON.stringify(
      jiraLookupResponse([{ accountId: "jira-account-1" }, { accountId: "jira-account-2" }]),
    );
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.additional_fields).toBeUndefined();
  });

  it("keeps Jira issue creation best-effort when account lookup throws", async () => {
    jiraLookupFailure = new Error("lookup exploded");
    await approveJiraCreate(
      '{"cloudId":"cloud-1","projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(toolCalls.map((call) => call.name)).toEqual(["lookupJiraAccountId", "createJiraIssue"]);
    expect(toolCalls[1].arguments?.additional_fields).toBeUndefined();
  });

  it("keeps Jira issue creation best-effort when cloudId is missing", async () => {
    await approveJiraCreate(
      '{"projectKey":"THOR","issueTypeName":"Task","summary":"Fix it","description":"body"}',
    );

    expect(jiraLookups).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments?.additional_fields).toBeUndefined();
  });

  it("blocks Jira approvals when contentFormat is not markdown", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });
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
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });
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
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });
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
    expect(firstBody).toEqual({ stdout: "created", stderr: "", exitCode: 0 });
    expect(toolCalls).toHaveLength(1);
  });

  it("keeps approvals pending when approved tool execution fails and returns a clear error for corrupt approved records", async () => {
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "parent-session",
      anchorId: activeAnchorId,
    });
    appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId });

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
