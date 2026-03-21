import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";

import { describe, expect, it, vi } from "vitest";

const {
  buildSandboxCommand,
  createDaytonaSandboxProvider,
  getRemoteWorkspaceDir,
  getSandboxWorktreeId,
  syncLocalDirectory,
} = await import("./daytona-sandbox-provider.js");

describe("daytona sandbox provider helpers", () => {
  it("derives a stable worktree id and remote workspace path", () => {
    const worktreePath = "/workspace/worktrees/acme-api/feat-sandbox";
    const worktreeId = getSandboxWorktreeId(worktreePath);

    expect(worktreeId).toHaveLength(24);
    expect(getRemoteWorkspaceDir(worktreePath)).toBe(
      posix.join("/tmp", `thor-worktree-${basename(worktreePath)}-${worktreeId}`),
    );
  });

  it("wraps exec requests in a shell with cwd and env", () => {
    const command = buildSandboxCommand({
      command: "pnpm test",
      cwd: "/tmp/project",
      env: {
        NODE_ENV: "test",
      },
    });

    expect(command).toContain("sh -lc ");
    expect(command).toContain("NODE_ENV");
    expect(command).toContain("pnpm test");
  });

  it("rejects invalid environment variable names", () => {
    expect(() =>
      buildSandboxCommand({
        command: "echo hi",
        env: {
          "bad-key": "value",
        },
      }),
    ).toThrow("Invalid environment variable name");
  });
});

describe("daytona sandbox provider", () => {
  it("finds sandboxes by worktree metadata", async () => {
    const worktreePath = "/workspace/worktrees/acme-api/feat-sandbox";
    const worktreeId = getSandboxWorktreeId(worktreePath);
    const sandbox = createFakeSandbox({
      labels: {
        "thor-worktree-id": worktreeId,
        "thor-worktree-path-b64": Buffer.from(worktreePath).toString("base64url"),
        "thor-repo-b64": Buffer.from("acme-api").toString("base64url"),
        "thor-branch-b64": Buffer.from("feat/sandbox").toString("base64url"),
        "thor-repo": "acme-api",
      },
    });

    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list(labels) {
          expect(labels).toEqual({ "thor-worktree-id": worktreeId });
          return { items: [sandbox] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          throw new Error("not used");
        },
      }),
    });

    await expect(
      provider.findByWorktree({ worktreePath, repo: "acme-api" }),
    ).resolves.toMatchObject({
      sandboxId: sandbox.id,
      provider: "daytona",
      identity: {
        worktreePath,
        repo: "acme-api",
      },
    });
  });

  it("reconstructs exact repo and branch identity from Daytona labels", async () => {
    const worktreePath = "/workspace/worktrees/acme-api/feat-sandbox";
    const sandbox = createFakeSandbox({
      labels: {
        "thor-worktree-id": getSandboxWorktreeId(worktreePath),
        "thor-worktree-path-b64": Buffer.from(worktreePath).toString("base64url"),
        "thor-repo-b64": Buffer.from("acme/api").toString("base64url"),
        "thor-branch-b64": Buffer.from("feat/sandbox/v2").toString("base64url"),
      },
    });
    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    await expect(provider.get(sandbox.id)).resolves.toMatchObject({
      identity: {
        worktreePath,
        repo: "acme/api",
        branch: "feat/sandbox/v2",
      },
    });
  });

  it("resumes a stopped sandbox before returning the record", async () => {
    const sandbox = createFakeSandbox({ state: "stopped" });
    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    const record = await provider.resume(sandbox.id);

    expect(sandbox.startCalls).toBe(1);
    expect(record.sandboxId).toBe(sandbox.id);
  });

  it("passes the requested sandbox language through create", async () => {
    const create = vi.fn().mockResolvedValue(createFakeSandbox());
    const provider = createDaytonaSandboxProvider({
      language: "typescript",
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        create,
        async get() {
          throw new Error("not used");
        },
      }),
    });

    await provider.create({
      worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
      repo: "acme-api",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript" }),
      expect.any(Object),
    );
  });

  it("passes the requested snapshot through create without forcing language", async () => {
    const create = vi.fn().mockResolvedValue(createFakeSandbox());
    const provider = createDaytonaSandboxProvider({
      snapshot: "daytona-medium",
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        create,
        async get() {
          throw new Error("not used");
        },
      }),
    });

    await provider.create({
      worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
      repo: "acme-api",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "daytona-medium" }),
      expect.any(Object),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("language");
  });

  it("streams stdout and stderr through exec events", async () => {
    const sandbox = createFakeSandbox();
    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    const events: Array<{ type: string; data: string }> = [];
    const result = await provider.exec(
      sandbox.id,
      {
        command: "echo hi",
      },
      (event) => events.push(event),
    );

    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      { type: "status", data: "running" },
      { type: "stdout", data: "stdout-from-session" },
      { type: "stderr", data: "stderr-from-session" },
      { type: "status", data: "completed:0" },
    ]);
  });

  it("returns direct command output when exec is called without a stream handler", async () => {
    const sandbox = createFakeSandbox({
      executeCommandResult: { exitCode: 0, result: "combined-output" },
    });
    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    await expect(provider.exec(sandbox.id, { command: "echo hi" })).resolves.toEqual({
      exitCode: 0,
      output: "combined-output",
    });
  });

  it("materializes a local worktree archive into the sandbox workspace", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "thor-daytona-materialize-test-"));
    const sandbox = createFakeSandbox();
    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    try {
      writeFileSync(join(tempDir, "package.json"), '{"name":"acme"}');
      await provider.materializeWorkspace(sandbox.id, { worktreePath: tempDir });
      expect(sandbox.uploadedFiles).toHaveLength(1);
      expect(sandbox.uploadedFiles[0].existedAtUpload).toBe(true);
      expect(sandbox.executedCommands.at(-1)).toContain(getRemoteWorkspaceDir(tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exports the remote workspace back into a local worktree", async () => {
    const worktreeDir = await mkdtemp(join(tmpdir(), "thor-daytona-export-worktree-"));
    const remoteDir = await mkdtemp(join(tmpdir(), "thor-daytona-export-remote-"));
    const remoteArchiveDir = await mkdtemp(join(tmpdir(), "thor-daytona-export-archive-"));
    const remoteArchivePath = join(remoteArchiveDir, "workspace.tgz");

    mkdirSync(join(worktreeDir, ".git"));
    writeFileSync(join(worktreeDir, "keep.txt"), "stale");
    writeFileSync(join(worktreeDir, "delete-me.txt"), "remove");

    mkdirSync(join(remoteDir, "src"), { recursive: true });
    writeFileSync(join(remoteDir, "keep.txt"), "fresh");
    writeFileSync(join(remoteDir, "src", "index.ts"), "export const value = 1;\n");

    await createArchiveFromDirectory(remoteDir, remoteArchivePath);

    const sandbox = createFakeSandbox({
      downloadFileImpl: async (_remotePath, localPath) => {
        await cp(remoteArchivePath, localPath);
      },
    });

    const provider = createDaytonaSandboxProvider({
      createClient: () => ({
        async list() {
          return { items: [] };
        },
        async create() {
          throw new Error("not used");
        },
        async get() {
          return sandbox;
        },
      }),
    });

    try {
      const result = await provider.exportWorkspace(sandbox.id, worktreeDir);

      expect(result.filesChanged).toBe(2);
      expect(result.filesDeleted).toBe(1);
      expect(readFileSync(join(worktreeDir, "keep.txt"), "utf8")).toBe("fresh");
      expect(readFileSync(join(worktreeDir, "src", "index.ts"), "utf8")).toContain("value = 1");
      expect(existsSync(join(worktreeDir, "delete-me.txt"))).toBe(false);
      expect(existsSync(join(worktreeDir, ".git"))).toBe(true);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(remoteArchiveDir, { recursive: true, force: true });
    }
  });
});

describe("syncLocalDirectory", () => {
  it("copies files, preserves excluded paths, and deletes stale managed files", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "thor-sync-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "thor-sync-target-"));

    try {
      mkdirSync(join(sourceDir, "nested"), { recursive: true });
      writeFileSync(join(sourceDir, "nested", "file.txt"), "fresh");
      symlinkSync("./nested/file.txt", join(sourceDir, "link.txt"));

      mkdirSync(join(targetDir, ".git"), { recursive: true });
      writeFileSync(join(targetDir, ".git", "HEAD"), "ref: refs/heads/main");
      writeFileSync(join(targetDir, "stale.txt"), "remove");

      const result = await syncLocalDirectory(sourceDir, targetDir);

      expect(result).toEqual({ filesChanged: 2, filesDeleted: 1 });
      expect(readFileSync(join(targetDir, "nested", "file.txt"), "utf8")).toBe("fresh");
      expect(existsSync(join(targetDir, "link.txt"))).toBe(true);
      expect(existsSync(join(targetDir, "stale.txt"))).toBe(false);
      expect(existsSync(join(targetDir, ".git", "HEAD"))).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function createFakeSandbox(
  options: {
    id?: string;
    state?: string;
    labels?: Record<string, string>;
    downloadFileImpl?: (remotePath: string, localPath: string) => Promise<void>;
    executeCommandResult?: { exitCode: number; result: string };
  } = {},
) {
  const sandbox = {
    id: options.id ?? "daytona-sandbox-123",
    state: options.state ?? "started",
    labels: options.labels ?? { "thor-worktree-id": "worktree-123" },
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:01.000Z",
    startCalls: 0,
    stopCalls: 0,
    deleteCalls: 0,
    uploadedFiles: [] as Array<{ localPath: string; remotePath: string; existedAtUpload: boolean }>,
    executedCommands: [] as string[],
    async start() {
      sandbox.startCalls += 1;
      sandbox.state = "started";
    },
    async stop() {
      sandbox.stopCalls += 1;
      sandbox.state = "stopped";
    },
    async delete() {
      sandbox.deleteCalls += 1;
    },
    fs: {
      async uploadFile(localPath: string, remotePath: string) {
        sandbox.uploadedFiles.push({
          localPath,
          remotePath,
          existedAtUpload: existsSync(localPath),
        });
      },
      async downloadFile(remotePath: string, localPath: string) {
        if (options.downloadFileImpl) {
          await options.downloadFileImpl(remotePath, localPath);
        }
      },
    },
    process: {
      async executeCommand(command: string) {
        sandbox.executedCommands.push(command);
        return options.executeCommandResult ?? { exitCode: 0, result: "" };
      },
      async createSession() {},
      async executeSessionCommand() {
        return { cmdId: "command-123" };
      },
      async getSessionCommandLogs(
        _sessionId: string,
        _commandId: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void,
      ) {
        onStdout("stdout-from-session");
        onStderr("stderr-from-session");
      },
      async getSessionCommand() {
        return { exitCode: 0 };
      },
    },
    async getSignedPreviewUrl() {
      return { url: "https://preview.example.com" };
    },
  };

  return sandbox;
}

async function createArchiveFromDirectory(sourceDir: string, archivePath: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "."], {
    maxBuffer: 1024 * 1024 * 16,
  });
}
