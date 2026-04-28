import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { WorkspaceConfig } from "@thor/common";
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

describe("remote-cli MCP endpoints", () => {
  let approvalsDir: string;
  let server: Server;
  let baseUrl: string;
  let toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
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
    approvalsDir = mkdtempSync(join(tmpdir(), "remote-cli-mcp-"));
    toolCalls = [];
    connectedUpstreams = [];
    const getConfig = Object.assign(() => config, {
      invalidate: () => {},
    });

    const remoteCli = createRemoteCliApp({
      getConfig,
      mcp: {
        approvalsDir,
        isProduction: true,
        internalSecret: "resolve-secret",
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
        internalSecret: "resolve-secret",
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

  it("creates approvals, exposes them via approval commands, and returns 401 for resolve without the internal secret", async () => {
    const pending = await postJson("/exec/mcp", {
      args: ["atlassian", "createJiraIssue", '{"projectKey":"THOR","summary":"Fix it"}'],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const pendingBody = (await pending.json()) as { stdout: string };

    expect(pending.status).toBe(200);
    expect(pendingBody.stdout).toContain("Approval required for `createJiraIssue`");
    expect(toolCalls).toEqual([]);

    const actionId = pendingBody.stdout.match(/"actionId":"([^"]+)"/)?.[1];
    expect(actionId).toBeTruthy();

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
      { name: "createJiraIssue", arguments: { projectKey: "THOR", summary: "Fix it" } },
    ]);
  });

  it("returns 401 for /internal/exec with missing or wrong internal secret", async () => {
    const missing = await postJson("/internal/exec", {
      bin: "echo",
      args: ["hello"],
      cwd: "/tmp",
    });
    expect(missing.status).toBe(401);

    const wrong = await postJson(
      "/internal/exec",
      {
        bin: "echo",
        args: ["hello"],
        cwd: "/tmp",
      },
      { "x-thor-internal-secret": "wrong" },
    );
    expect(wrong.status).toBe(401);
  });

  it("returns 401 for /github/pr-head without the internal secret", async () => {
    const response = await fetch(`${baseUrl}/github/pr-head?installation=1&repo=acme%2Frepo&number=1`);
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
      timedOut: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(0);
    expect(body.stdout.trim()).toBe("hello");
    expect(body.stderr).toBe("");
    expect(body.timedOut).toBe(false);
  });

  it("returns timedOut=true for /internal/exec timeout", async () => {
    const response = await postJson(
      "/internal/exec",
      {
        bin: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: "/tmp",
        timeoutMs: 100,
      },
      { "x-thor-internal-secret": "resolve-secret" },
    );
    const body = (await response.json()) as {
      exitCode: number;
      timedOut: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(1);
    expect(body.timedOut).toBe(true);
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
