import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    name: "listChannels",
    description: "List channels",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deleteMessage",
    description: "Delete a message",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, ts: { type: "string" } },
      required: ["channel", "ts"],
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
  let closeRemoteCli: () => Promise<void>;

  const config: WorkspaceConfig = {
    repos: {
      acme: {
        proxies: ["slack"],
      },
    },
    proxies: {
      slack: {
        upstream: { url: "http://example.test/mcp" },
        allow: ["listChannels"],
        approve: ["deleteMessage"],
      },
    },
  };

  beforeEach(async () => {
    approvalsDir = mkdtempSync(join(tmpdir(), "remote-cli-mcp-"));
    toolCalls = [];
    const getConfig = Object.assign(() => config, {
      invalidate: () => {},
    });

    const remoteCli = createRemoteCliApp({
      getConfig,
      mcp: {
        approvalsDir,
        resolveSecret: "resolve-secret",
        writeToolCallLogFn: () => {},
        connectUpstreamFn: async (): Promise<UpstreamConnection> => ({
          tools,
          client: {
            callTool: async ({ name, arguments: args }) => {
              toolCalls.push({ name, arguments: args });
              if (name === "listChannels") {
                return {
                  content: [{ type: "text", text: "general\nengineering" }],
                };
              }
              if (name === "deleteMessage") {
                return {
                  content: [{ type: "text", text: "deleted" }],
                };
              }
              throw new Error(`Unexpected tool: ${name}`);
            },
            close: async () => {},
          } as UpstreamConnection["client"],
        }),
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
      upstreams: [{ name: "slack", toolCount: 0, connected: false }],
    });

    const listedTools = await postJson("/exec/mcp", {
      args: ["slack"],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const toolsBody = (await listedTools.json()) as { stdout: string };

    expect(listedTools.status).toBe(200);
    expect(toolsBody.stdout.trim().split("\n")).toEqual(["listChannels", "deleteMessage"]);

    const call = await postJson("/exec/mcp", {
      args: ["slack", "listChannels", "{}"],
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
      stdout: "general\nengineering",
      stderr: "",
      exitCode: 0,
    });
    expect(toolCalls).toEqual([{ name: "listChannels", arguments: {} }]);

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as {
      mcp: { instances: { slack: { connected: boolean; tools: number } } };
    };

    expect(health.status).toBe(200);
    expect(healthBody.mcp.instances.slack).toEqual({ connected: true, tools: 3 });
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

  it("creates approvals, exposes them via approval commands, and blocks resolve without the secret", async () => {
    const pending = await postJson("/exec/mcp", {
      args: ["slack", "deleteMessage", '{"channel":"C1","ts":"123"}'],
      cwd: "/workspace/repos/acme",
      directory: "/workspace/repos/acme",
    });
    const pendingBody = (await pending.json()) as { stdout: string };

    expect(pending.status).toBe(200);
    expect(pendingBody.stdout).toContain("Approval required for `deleteMessage`");
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
      upstream: "slack",
      status: "pending",
      tool: "deleteMessage",
    });

    const list = await postJson("/exec/approval", { args: ["list"] });
    const listBody = (await list.json()) as { stdout: string };
    expect(list.status).toBe(200);
    expect(JSON.parse(listBody.stdout)).toMatchObject({
      approvals: [expect.objectContaining({ id: actionId, upstream: "slack", status: "pending" })],
    });

    const deniedResolve = await postJson("/exec/mcp", {
      args: ["resolve", actionId, "approved", "U123"],
    });
    const deniedBody = (await deniedResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(deniedResolve.status).toBe(200);
    expect(deniedBody).toMatchObject({
      stdout: "",
      stderr: "Unknown subcommand: resolve\n",
      exitCode: 1,
    });

    const allowedResolve = await postJson(
      "/exec/mcp",
      { args: ["resolve", actionId, "approved", "U123"] },
      { "x-thor-resolve-secret": "resolve-secret" },
    );
    const allowedBody = (await allowedResolve.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(allowedResolve.status).toBe(200);
    expect(allowedBody).toMatchObject({
      stdout: "deleted",
      stderr: "",
      exitCode: 0,
    });
    expect(toolCalls).toEqual([{ name: "deleteMessage", arguments: { channel: "C1", ts: "123" } }]);
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
