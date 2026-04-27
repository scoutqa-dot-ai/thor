import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { normalize as normalizePosix } from "node:path/posix";
import type { WorkspaceConfig } from "@thor/common";

interface FakeSandbox {
  id: string;
  name: string;
  labels: Record<string, string>;
  fs: {
    uploadFile: ReturnType<typeof vi.fn>;
    uploadFiles: ReturnType<typeof vi.fn>;
    downloadFiles: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
  };
  process: {
    executeCommand: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    executeSessionCommand: ReturnType<typeof vi.fn>;
    getSessionCommandLogs: ReturnType<typeof vi.fn>;
    getSessionCommand: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
  setLabels: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  daytonaState: {
    sandboxes: new Map<string, FakeSandbox>(),
    createCalls: [] as Array<Record<string, unknown>>,
    idCounter: 1,
  },
  daytonaCreateMock: vi.fn(),
  daytonaListMock: vi.fn(),
  daytonaGetMock: vi.fn(),
}));

const execCommandMock = hoisted.execCommandMock;
const daytonaCreateMock = hoisted.daytonaCreateMock;
const daytonaListMock = hoisted.daytonaListMock;
const daytonaGetMock = hoisted.daytonaGetMock;
const daytonaState: {
  sandboxes: Map<string, FakeSandbox>;
  createCalls: Array<Record<string, unknown>>;
  idCounter: number;
} = hoisted.daytonaState;

vi.mock("./exec.js", () => ({
  execCommand: hoisted.execCommandMock,
  execCommandStream: vi.fn(),
}));

vi.mock("@daytonaio/sdk", () => {
  class MockDaytona {
    create = hoisted.daytonaCreateMock;
    list = hoisted.daytonaListMock;
    get = hoisted.daytonaGetMock;
  }

  return {
    Daytona: MockDaytona,
  };
});

import { _testing, THOR_CWD_LABEL, THOR_MANAGED_LABEL, THOR_SHA_LABEL } from "./sandbox.js";
import { createRemoteCliApp } from "./index.js";

const CWD = "/workspace/worktrees/acme/feat-sandbox";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describe("/exec/sandbox", () => {
  let server: Server;
  let closeRemoteCli: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    vi.spyOn(realpathSync, "native").mockImplementation((path) => normalizePosix(String(path)));

    daytonaState.sandboxes.clear();
    daytonaState.createCalls = [];
    daytonaState.idCounter = 1;

    execCommandMock.mockReset();
    daytonaCreateMock.mockClear();
    daytonaListMock.mockClear();
    daytonaGetMock.mockClear();

    daytonaCreateMock.mockImplementation(async (params: Record<string, unknown>) => {
      daytonaState.createCalls.push(params);
      const id = `sbx-${daytonaState.idCounter++}`;
      const labels = (params.labels as Record<string, string> | undefined) || {};
      const sandbox = makeSandbox(id, (params.name as string | undefined) || id, labels);
      daytonaState.sandboxes.set(id, sandbox);
      return sandbox;
    });

    daytonaListMock.mockImplementation(async (labels?: Record<string, string>) => {
      const items = Array.from(daytonaState.sandboxes.values()).filter((sandbox) => {
        if (!labels) return true;
        return Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value);
      });
      return { items };
    });

    daytonaGetMock.mockImplementation(async (id: string) => {
      const sandbox = daytonaState.sandboxes.get(id);
      if (!sandbox) {
        throw new Error("404 not found");
      }
      return sandbox;
    });

    _testing.resetDaytona();
    _testing.resetCwdLocks();
    vi.stubEnv("DAYTONA_API_KEY", "daytona_test_key");

    configureGitExec({ dirty: false, headSha: HEAD_SHA });

    const config = Object.assign(
      () =>
        ({
          repos: {},
        }) as WorkspaceConfig,
      { invalidate: () => {} },
    );

    const remoteCli = createRemoteCliApp({ getConfig: config });
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("syncs, streams, and returns exit code on happy path", async () => {
    const sandbox = makeSandbox("sbx-1", "thor-acme", {
      [THOR_MANAGED_LABEL]: "true",
      [THOR_CWD_LABEL]: CWD,

      [THOR_SHA_LABEL]: OLD_SHA,
    });
    daytonaState.sandboxes.set(sandbox.id, sandbox);

    const response = await postJson("/exec/sandbox", {
      args: ["pytest", "-q"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(response);
    expect(events).toEqual([
      { type: "stdout", data: "sandbox run output\n" },
      { type: "exit", exitCode: 0 },
    ]);

    // Sandbox SHA updated after sync
    expect(sandbox.labels[THOR_SHA_LABEL]).toBe(HEAD_SHA);
  });

  it("auto-creates sandbox when none exists for cwd", async () => {
    const response = await postJson("/exec/sandbox", {
      args: ["./gradlew", "build"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events.at(-1)).toEqual({ type: "exit", exitCode: 0 });

    // A sandbox was created and is findable by cwd
    expect(daytonaState.sandboxes.size).toBe(1);
    const [sandbox] = daytonaState.sandboxes.values();
    expect(sandbox.labels[THOR_CWD_LABEL]).toBe(CWD);
    expect(sandbox.labels[THOR_MANAGED_LABEL]).toBe("true");
  });

  it("handles parallel exec requests on same cwd", async () => {
    configureGitExec({ dirty: true, headSha: HEAD_SHA });

    const [response1, response2] = await Promise.all([
      postJson("/exec/sandbox", { args: ["make", "build"], cwd: CWD }),
      postJson("/exec/sandbox", { args: ["make", "test"], cwd: CWD }),
    ]);

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    const events1 = await readNdjson(response1);
    const events2 = await readNdjson(response2);

    expect(events1.at(-1)).toEqual({ type: "exit", exitCode: 0 });
    expect(events2.at(-1)).toEqual({ type: "exit", exitCode: 0 });
  });

  it("allows sandbox-only subdirectory cwd under a valid worktree", async () => {
    vi.mocked(realpathSync.native).mockImplementation((path) => {
      const normalized = normalizePosix(String(path));
      if (normalized === `${CWD}/pulltest`) {
        throw new Error("ENOENT");
      }
      return normalized;
    });

    const response = await postJson("/exec/sandbox", {
      args: ["bash", "-c", "echo pull-content-e2e > created.txt"],
      cwd: `${CWD}/pulltest`,
    });

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events.at(-1)).toEqual({ type: "exit", exitCode: 0 });
    expect(getExecutedCommand()).toContain("pulltest");
    expect(getExecutedCommand()).toContain("echo pull-content-e2e > created.txt");
  });

  it("rejects sandbox cwd traversal before ancestor fallback", async () => {
    const response = await postJson("/exec/sandbox", {
      args: ["true"],
      cwd: `${CWD}/../evil`,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { stderr: string };
    expect(body.stderr).toContain("cwd must be under /workspace/worktrees");
  });

  it("reports pullback failures as exec failures", async () => {
    const sandbox = makeSandbox("sbx-1", "thor-acme", {
      [THOR_MANAGED_LABEL]: "true",
      [THOR_CWD_LABEL]: CWD,

      [THOR_SHA_LABEL]: HEAD_SHA,
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("git bundle unbundle")) {
        return { exitCode: 0, result: "" };
      }
      if (command.includes("git status --porcelain -uall -z")) {
        return { exitCode: 1, result: "status failed" };
      }
      return { exitCode: 0, result: "sandbox run output\n" };
    });
    daytonaState.sandboxes.set(sandbox.id, sandbox);

    const response = await postJson("/exec/sandbox", {
      args: ["pytest", "-q"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events).toEqual([
      { type: "stdout", data: "sandbox run output\n" },
      {
        type: "stderr",
        data: "Failed to read sandbox state after exec. No files were pulled back.\n",
      },
      { type: "exit", exitCode: 1 },
    ]);
  });

  async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function getExecutedCommand(): string {
    const sandbox = Array.from(daytonaState.sandboxes.values())[0];
    const call = sandbox.process.executeSessionCommand.mock.calls[0];
    return call[1].command as string;
  }

  describe("shell unwrap", () => {
    it("unwraps bash -c into outer login shell", async () => {
      const response = await postJson("/exec/sandbox", {
        args: ["bash", "-c", "sdk use java 17 && mvn test"],
        cwd: CWD,
      });

      expect(response.status).toBe(200);
      const cmd = getExecutedCommand();
      expect(cmd).toContain("bash -lc");
      expect(cmd).toContain("sdk use java 17 && mvn test");
      expect(cmd).not.toContain("'bash'");
    });

    it("unwraps sh -lc into outer login shell", async () => {
      const response = await postJson("/exec/sandbox", {
        args: ["sh", "-lc", "make build && make test"],
        cwd: CWD,
      });

      expect(response.status).toBe(200);
      const cmd = getExecutedCommand();
      expect(cmd).toContain("bash -lc");
      expect(cmd).toContain("make build && make test");
      expect(cmd).not.toContain("'sh'");
    });
  });

  describe("shell validation", () => {
    it("blocks bare sh/bash with no -c flag", async () => {
      const response = await postJson("/exec/sandbox", {
        args: ["bash"],
        cwd: CWD,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { stderr: string };
      expect(body.stderr).toContain("sandbox bash -c");
    });

    it("blocks sh with extra flags", async () => {
      const response = await postJson("/exec/sandbox", {
        args: ["sh", "-e", "-c", "make test"],
        cwd: CWD,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { stderr: string };
      expect(body.stderr).toContain("sandbox sh -c");
    });

    it("blocks bash -c with extra positional args", async () => {
      const response = await postJson("/exec/sandbox", {
        args: ["bash", "-c", "echo hello", "arg0"],
        cwd: CWD,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { stderr: string };
      expect(body.stderr).toContain("sandbox bash -c");
    });
  });
});

describe("parseGitStatus", () => {
  it("treats rename entries as upload target plus delete source in -z format", () => {
    expect(_testing.parseGitStatus("R  new-name.txt\0old-name.txt\0")).toEqual({
      uploads: ["new-name.txt"],
      deletes: ["old-name.txt"],
    });
  });

  it("treats copy entries as upload-only in -z format", () => {
    expect(_testing.parseGitStatus("C  copy.txt\0source.txt\0")).toEqual({
      uploads: ["copy.txt"],
      deletes: [],
    });
  });
});

function configureGitExec(options: { dirty: boolean; headSha: string }): void {
  execCommandMock.mockImplementation(async (binary: string, args: string[]) => {
    if (binary !== "git") {
      return { stdout: "", stderr: "unknown binary", exitCode: 1 };
    }

    if (args[0] === "status" && args[1] === "--porcelain") {
      return {
        stdout: options.dirty ? " M src/index.ts\n" : "",
        stderr: "",
        exitCode: 0,
      };
    }

    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { stdout: `${CWD}\n`, stderr: "", exitCode: 0 };
    }

    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: `${options.headSha}\n`, stderr: "", exitCode: 0 };
    }

    if (args[0] === "bundle" && args[1] === "create") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function makeSandbox(id: string, name: string, labels: Record<string, string>): FakeSandbox {
  let cmdCounter = 0;
  const sandbox: FakeSandbox = {
    id,
    name,
    labels: { ...labels },
    fs: {
      uploadFile: vi.fn(async () => {}),
      uploadFiles: vi.fn(async () => {}),
      downloadFiles: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
    },
    process: {
      executeCommand: vi.fn(async (command: string) => {
        if (command.includes("git bundle unbundle")) {
          return { exitCode: 0, result: "" };
        }
        if (command.includes("git status --porcelain -uall -z")) {
          return { exitCode: 0, result: "" };
        }
        if (command.includes("stat -c")) {
          return { exitCode: 0, result: "" };
        }
        return { exitCode: 0, result: "sandbox run output\n" };
      }),
      createSession: vi.fn(async () => {}),
      executeSessionCommand: vi.fn(async () => {
        const cmdId = `cmd-${++cmdCounter}`;
        return { cmdId };
      }),
      getSessionCommandLogs: vi.fn(
        async (
          _sessionId: string,
          _commandId: string,
          onStdout?: (chunk: string) => void,
          _onStderr?: (chunk: string) => void,
        ) => {
          if (onStdout) {
            onStdout("sandbox run output\n");
          }
        },
      ),
      getSessionCommand: vi.fn(async () => ({
        id: `cmd-${cmdCounter}`,
        command: "",
        exitCode: 0,
      })),
      deleteSession: vi.fn(async () => {}),
    },
    setLabels: vi.fn(async (nextLabels: Record<string, string>) => {
      sandbox.labels = { ...nextLabels };
      return sandbox.labels;
    }),
    delete: vi.fn(async () => {
      daytonaState.sandboxes.delete(id);
    }),
  };

  return sandbox;
}

async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
