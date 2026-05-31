import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { execCommandStreamMock } = vi.hoisted(() => ({
  execCommandStreamMock: vi.fn(),
}));

vi.mock("./exec.ts", () => ({
  execCommand: vi.fn(),
  execCommandStream: execCommandStreamMock,
}));

import { createRemoteCliApp, createSafeNdjsonWriter } from "./index.ts";

describe("remote-cli docker endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;

  beforeEach(async () => {
    execCommandStreamMock.mockReset();

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
  });

  it("streams allowed docker subcommands through the real docker binary", async () => {
    execCommandStreamMock.mockImplementation(
      async (
        _bin,
        _args,
        _cwd,
        callbacks: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void },
      ) => {
        callbacks.onStdout("CONTAINER ID   NAMES\n");
        callbacks.onStderr("warning\n");
        return 0;
      },
    );

    const response = await postJson("/exec/docker", {
      args: ["ps", "--all"],
      cwd: "/workspace/repos/example",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await response.text()).toBe(
      JSON.stringify({ type: "stdout", data: "CONTAINER ID   NAMES\n" }) +
        "\n" +
        JSON.stringify({ type: "stderr", data: "warning\n" }) +
        "\n" +
        JSON.stringify({ type: "exit", exitCode: 0 }) +
        "\n",
    );
    expect(execCommandStreamMock).toHaveBeenCalledWith(
      "docker",
      ["ps", "--all"],
      "/workspace",
      expect.objectContaining({ onStdout: expect.any(Function), onStderr: expect.any(Function) }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("allows logs and stats", async () => {
    execCommandStreamMock.mockResolvedValue(0);

    await postJson("/exec/docker", { args: ["logs", "--tail", "20", "remote-cli"] });
    await postJson("/exec/docker", { args: ["stats", "--no-stream", "remote-cli"] });

    expect(execCommandStreamMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["logs", "--tail", "20", "remote-cli"],
      "/workspace",
      expect.any(Object),
      expect.any(Object),
    );
    expect(execCommandStreamMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["stats", "--no-stream", "remote-cli"],
      "/workspace",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects denied docker subcommands before execution", async () => {
    const response = await postJson("/exec/docker", {
      args: ["inspect", "remote-cli"],
    });
    const body = (await response.json()) as { stdout: string; stderr: string; exitCode: number };

    expect(response.status).toBe(400);
    expect(body.stdout).toBe("");
    expect(body.stderr).toContain("only docker ps, docker logs, and docker stats");
    expect(body.exitCode).toBe(1);
    expect(execCommandStreamMock).not.toHaveBeenCalled();
  });

  it("rejects daemon selector flags before execution", async () => {
    const response = await postJson("/exec/docker", {
      args: ["ps", "--host=unix:///tmp/docker.sock"],
    });
    const body = (await response.json()) as { stderr: string };

    expect(response.status).toBe(400);
    expect(body.stderr).toContain('flag "--host" is not allowed for docker');
    expect(execCommandStreamMock).not.toHaveBeenCalled();
  });

  it("safe NDJSON writer no-ops after end or destroy and swallows write errors", () => {
    const write = vi.fn();
    const writer = createSafeNdjsonWriter({
      write,
      writableEnded: false,
      destroyed: false,
    });

    writer({ type: "stdout", data: "ok\n" });
    expect(write).toHaveBeenCalledWith(JSON.stringify({ type: "stdout", data: "ok\n" }) + "\n");

    const endedWriter = createSafeNdjsonWriter({
      write: vi.fn(() => {
        throw new Error("should not write");
      }),
      writableEnded: true,
      destroyed: false,
    });
    expect(() => endedWriter({ type: "heartbeat" })).not.toThrow();

    const throwingWriter = createSafeNdjsonWriter({
      write: vi.fn(() => {
        throw new Error("write after end");
      }),
      writableEnded: false,
      destroyed: false,
    });
    expect(() => throwingWriter({ type: "heartbeat" })).not.toThrow();
  });

  async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});
