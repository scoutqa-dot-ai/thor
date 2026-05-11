import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  appendAlias,
  appendSessionEvent,
  formatThorDisclaimerFooter,
  type WorkspaceConfig,
} from "@thor/common";
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
    name: "hiddenTool",
    description: "Should stay hidden",
    inputSchema: { type: "object" },
  },
];

const worklogDir = "/tmp/thor-remote-cli-mcp-test/worklog";
const activeTriggerId = "00000000-0000-7000-8000-000000000101";
const activeAnchorId = "00000000-0000-7000-8000-0000000004a1";

describe("remote-cli MCP endpoints", () => {
  let approvalsDir: string;
  let server: Server;
  let baseUrl: string;
  let toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  let createJiraIssueDelay: Promise<void> | undefined;
  let createJiraIssueFailure: Error | undefined;
  let connectedUpstreams: string[];
  let closeRemoteCli: () => Promise<void>;

  const config: WorkspaceConfig = {
    repos: {
      acme: {
        proxies: ["atlassian"],
      },
    },
  };

  beforeEach(async () => {
    vi.stubEnv("ATLASSIAN_AUTH", "Basic dGVzdA==");
    vi.stubEnv("THOR_INTERNAL_SECRET", "resolve-secret");
    vi.stubEnv("WORKLOG_DIR", worklogDir);
    vi.stubEnv("RUNNER_BASE_URL", "https://thor.example.com/");
    rmSync("/tmp/thor-remote-cli-mcp-test", { recursive: true, force: true });
    approvalsDir = mkdtempSync(join(tmpdir(), "remote-cli-mcp-"));
    toolCalls = [];
    createJiraIssueDelay = undefined;
    createJiraIssueFailure = undefined;
    connectedUpstreams = [];
    const getConfig = Object.assign(() => config, {
      invalidate: () => {},
    });

    const remoteCli = createRemoteCliApp({
      getConfig,
      mcp: {
        approvalsDir,
        isProduction: true,
        writeToolCallLogFn: () => {},
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

  it("lists allowed upstreams and visible tools, then calls an allowed tool", async () => {
    const upstreams = await postJson("/exec/mcp", {
      args: [],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const upstreamBody = (await upstreams.json()) as { stdout: string };

    expect(upstreams.status).toBe(200);
    expect(JSON.parse(upstreamBody.stdout)).toEqual({
      upstreams: [{ name: "atlassian", toolCount: 0, connected: false }],
    });

    const listedTools = await postJson("/exec/mcp", {
      args: ["atlassian"],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const toolsBody = (await listedTools.json()) as { stdout: string };

    expect(listedTools.status).toBe(200);
    expect(toolsBody.stdout.trim().split("\n")).toEqual(["getJiraIssue", "createJiraIssue"]);

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
    expect(healthBody.mcp.configured).toBe(1);
    expect(healthBody.mcp.instances.atlassian).toEqual({ connected: true, tools: 3 });
  });

  it("warms only upstreams enabled by repo config", async () => {
    await closeRemoteCli();

    const getConfig = Object.assign(() => config, {
      invalidate: () => {},
    });

    const remoteCli = createRemoteCliApp({
      getConfig,
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

    expect(connectedUpstreams).toEqual(["atlassian"]);
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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });

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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });
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
      description: `body\n${formatThorDisclaimerFooter(`https://thor.example.com/runner/v/${activeAnchorId}/${activeTriggerId}`)}`,
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

  it("blocks Jira approvals when contentFormat is not markdown", async () => {
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });
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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });
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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });
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
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "parent-session",
        anchorId: activeAnchorId,
      }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("parent-session", { type: "trigger_start", triggerId: activeTriggerId }),
    ).toEqual({ ok: true });

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
