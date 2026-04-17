import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { execCommandMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
}));

vi.mock("./exec.js", () => ({
  execCommand: execCommandMock,
  execCommandStream: vi.fn(),
}));

import { createRemoteCliApp } from "./index.js";

describe("remote-cli ldcli endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  const originalEnv = {
    LD_ACCESS_TOKEN: process.env.LD_ACCESS_TOKEN,
    LD_BASE_URI: process.env.LD_BASE_URI,
    LD_PROJECT: process.env.LD_PROJECT,
    LD_ENVIRONMENT: process.env.LD_ENVIRONMENT,
  };

  beforeEach(async () => {
    execCommandMock.mockReset();
    process.env.LD_ACCESS_TOKEN = "ld-token";
    process.env.LD_BASE_URI = "https://app.launchdarkly.test";
    process.env.LD_PROJECT = "default";
    process.env.LD_ENVIRONMENT = "production";

    const remoteCli = createRemoteCliApp();
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

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("appends json output and executes ldcli in /workspace", async () => {
    execCommandMock.mockResolvedValue({
      stdout: '{"items":[]}',
      stderr: "",
      exitCode: 0,
    });

    const response = await postJson("/exec/ldcli", {
      args: ["flags", "list", "--project", "default", "--limit", "5"],
      cwd: "/workspace/repos/example",
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stdout: '{"items":[]}',
      stderr: "",
      exitCode: 0,
    });
    expect(execCommandMock).toHaveBeenCalledWith(
      "ldcli",
      ["flags", "list", "--project", "default", "--limit", "5", "--output", "json"],
      "/workspace",
      {
        env: {
          LD_ACCESS_TOKEN: "ld-token",
          LD_BASE_URI: "https://app.launchdarkly.test",
          LD_PROJECT: "default",
          LD_ENVIRONMENT: "production",
        },
        maxBuffer: 1024 * 1024,
      },
    );
  });

  it("keeps explicit output flags unchanged", async () => {
    execCommandMock.mockResolvedValue({
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });

    await postJson("/exec/ldcli", {
      args: ["flags", "list", "--project", "default", "--output", "json"],
    });
    await postJson("/exec/ldcli", {
      args: ["projects", "list", "--json"],
    });

    expect(execCommandMock).toHaveBeenNthCalledWith(
      1,
      "ldcli",
      ["flags", "list", "--project", "default", "--output", "json"],
      "/workspace",
      expect.any(Object),
    );
    expect(execCommandMock).toHaveBeenNthCalledWith(
      2,
      "ldcli",
      ["projects", "list", "--json"],
      "/workspace",
      expect.any(Object),
    );
  });

  it("rejects policy violations before execution", async () => {
    const response = await postJson("/exec/ldcli", {
      args: ["flags", "create", "--project", "default"],
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(400);
    expect(body.stdout).toBe("");
    expect(body.stderr).toContain('"ldcli flags create" is not allowed');
    expect(body.exitCode).toBe(1);
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it("rejects missing project scope before execution", async () => {
    const response = await postJson("/exec/ldcli", {
      args: ["flags", "list"],
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(400);
    expect(body).toEqual({
      stdout: "",
      stderr: '"ldcli flags list" requires "--project <key>"',
      exitCode: 1,
    });
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});
