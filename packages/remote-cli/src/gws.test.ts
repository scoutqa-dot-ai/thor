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

describe("remote-cli gws endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;
  const originalEnv = {
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR,
    GOOGLE_WORKSPACE_PROJECT_ID: process.env.GOOGLE_WORKSPACE_PROJECT_ID,
  };

  beforeEach(async () => {
    execCommandMock.mockReset();
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE =
      "/var/lib/remote-cli/google-workspace/credentials/service-account.json";
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = "/var/lib/remote-cli/google-workspace/config";
    process.env.GOOGLE_WORKSPACE_PROJECT_ID = "thor-project";

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

  it("appends json format and executes gws in /workspace", async () => {
    execCommandMock.mockResolvedValue({
      stdout: '{"files":[]}',
      stderr: "",
      exitCode: 0,
    });

    const response = await postJson("/exec/gws", {
      args: ["drive", "files", "list", "--params", '{"pageSize":5}'],
      cwd: "/workspace/repos/example",
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stdout: '{"files":[]}',
      stderr: "",
      exitCode: 0,
    });
    expect(execCommandMock).toHaveBeenCalledWith(
      "gws",
      ["drive", "files", "list", "--params", '{"pageSize":5}', "--format", "json"],
      "/workspace",
      {
        env: {
          GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:
            "/var/lib/remote-cli/google-workspace/credentials/service-account.json",
          GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/var/lib/remote-cli/google-workspace/config",
          GOOGLE_WORKSPACE_PROJECT_ID: "thor-project",
        },
      },
    );
  });

  it("does not append json format to help or schema commands", async () => {
    execCommandMock.mockResolvedValue({ stdout: "help", stderr: "", exitCode: 0 });

    await postJson("/exec/gws", { args: ["drive", "--help"] });
    await postJson("/exec/gws", { args: ["schema", "drive.files.list"] });

    expect(execCommandMock).toHaveBeenNthCalledWith(
      1,
      "gws",
      ["drive", "--help"],
      "/workspace",
      expect.any(Object),
    );
    expect(execCommandMock).toHaveBeenNthCalledWith(
      2,
      "gws",
      ["schema", "drive.files.list"],
      "/workspace",
      expect.any(Object),
    );
  });

  it("rejects policy violations before execution", async () => {
    const response = await postJson("/exec/gws", {
      args: ["drive", "files", "create", "--json", "{}"],
    });
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    expect(response.status).toBe(400);
    expect(body.stdout).toBe("");
    expect(body.stderr).toContain('"gws drive files create" is not allowed');
    expect(body.exitCode).toBe(1);
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
