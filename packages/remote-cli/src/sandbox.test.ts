import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkspaceConfig } from "@thor/common";

interface FakeSandbox {
  id: string;
  name: string;
  labels: Record<string, string>;
  fs: { uploadFile: ReturnType<typeof vi.fn> };
  process: { executeCommand: ReturnType<typeof vi.fn> };
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

import {
  __resetDaytonaForTests,
  THOR_BRANCH_LABEL,
  THOR_CWD_LABEL,
  THOR_MANAGED_LABEL,
  THOR_SHA_LABEL,
} from "./sandbox.js";
import { createRemoteCliApp } from "./index.js";

const CWD = "/workspace/worktrees/acme/feat-sandbox";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describe("/exec/sandbox", () => {
  let server: Server;
  let closeRemoteCli: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
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

    __resetDaytonaForTests();
    vi.stubEnv("DAYTONA_API_KEY", "daytona_test_key");

    configureGitExec({ dirty: false, headSha: HEAD_SHA, branch: "feat/sandbox" });

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
  });

  it("streams exec output on happy path", async () => {
    const sandbox = makeSandbox("sbx-1", "thor-acme", {
      [THOR_MANAGED_LABEL]: "true",
      [THOR_CWD_LABEL]: CWD,
      [THOR_BRANCH_LABEL]: "feat/sandbox",
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
    expect(events).toEqual([{ stream: "stdout", data: "sandbox run output\n" }, { exitCode: 0 }]);

    const bundleCall = execCommandMock.mock.calls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "bundle",
    );
    expect(bundleCall?.[1]?.[3]).toBe(`${OLD_SHA}..HEAD`);
    expect(sandbox.labels[THOR_SHA_LABEL]).toBe(HEAD_SHA);
  });

  it("auto-stashes dirty worktree and undoes temp commit", async () => {
    configureGitExec({ dirty: true, headSha: HEAD_SHA, branch: "feat/sandbox" });

    const response = await postJson("/exec/sandbox", {
      args: ["npm", "test"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events).toEqual([{ stream: "stdout", data: "sandbox run output\n" }, { exitCode: 0 }]);

    // Verify temp commit flow: add, commit, then reset after sync
    const addCall = execCommandMock.mock.calls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "add",
    );
    expect(addCall?.[1]).toEqual(["add", "-A"]);

    const commitCall = execCommandMock.mock.calls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "commit",
    );
    expect(commitCall?.[1]).toContain("thor-sandbox-wip");

    const resetCall = execCommandMock.mock.calls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "reset",
    );
    expect(resetCall?.[1]).toEqual(["reset", "--mixed", "HEAD~1"]);
  });

  it("skips sync when SHA is unchanged", async () => {
    const sandbox = makeSandbox("sbx-1", "thor-acme", {
      [THOR_MANAGED_LABEL]: "true",
      [THOR_CWD_LABEL]: CWD,
      [THOR_BRANCH_LABEL]: "feat/sandbox",
      [THOR_SHA_LABEL]: HEAD_SHA,
    });
    daytonaState.sandboxes.set(sandbox.id, sandbox);

    const response = await postJson("/exec/sandbox", {
      args: ["mvn", "test"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    expect(events).toEqual([{ stream: "stdout", data: "sandbox run output\n" }, { exitCode: 0 }]);

    const bundleCalls = execCommandMock.mock.calls.filter(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "bundle",
    );
    expect(bundleCalls).toHaveLength(0);
  });

  it("auto-creates sandbox when missing", async () => {
    const response = await postJson("/exec/sandbox", {
      args: ["./gradlew", "build"],
      cwd: CWD,
    });

    expect(response.status).toBe(200);
    await readNdjson(response);

    expect(daytonaCreateMock).toHaveBeenCalledTimes(1);
    expect(daytonaState.createCalls[0]).toMatchObject({
      ephemeral: true,
      autoStopInterval: 15,
      labels: {
        [THOR_MANAGED_LABEL]: "true",
        [THOR_CWD_LABEL]: CWD,
        [THOR_BRANCH_LABEL]: "feat/sandbox",
        [THOR_SHA_LABEL]: HEAD_SHA,
      },
    });

    const bundleCall = execCommandMock.mock.calls.find(
      (call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "bundle",
    );
    expect(bundleCall?.[1]?.[3]).toBe("HEAD");
  });

  it("treats stop as no-op when sandbox does not exist", async () => {
    const response = await postJson("/exec/sandbox", {
      mode: "stop",
      cwd: CWD,
    });

    const body = (await response.json()) as { stdout: string; stderr: string; exitCode: number };
    expect(response.status).toBe(200);
    expect(body).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(daytonaCreateMock).not.toHaveBeenCalled();
    expect(daytonaGetMock).not.toHaveBeenCalled();
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
});

function configureGitExec(options: { dirty: boolean; headSha: string; branch: string }): void {
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

    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: `${options.headSha}\n`, stderr: "", exitCode: 0 };
    }

    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
      return { stdout: `${options.branch}\n`, stderr: "", exitCode: 0 };
    }

    if (args[0] === "bundle" && args[1] === "create") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function makeSandbox(id: string, name: string, labels: Record<string, string>): FakeSandbox {
  const sandbox: FakeSandbox = {
    id,
    name,
    labels: { ...labels },
    fs: {
      uploadFile: vi.fn(async () => {}),
    },
    process: {
      executeCommand: vi.fn(async (command: string) => {
        if (command.includes("git bundle unbundle")) {
          return { exitCode: 0, result: "" };
        }
        return { exitCode: 0, result: "sandbox run output\n" };
      }),
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
