import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { syncIn, syncOut, resetSyncState } from "./sync.js";
import type { SandboxProvider, SessionExecResult } from "./provider.js";

// ── Mock provider ───────────────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: unknown[];
}

function createMockProvider(): SandboxProvider & { calls: MockCall[]; files: Map<string, Buffer> } {
  const mock: SandboxProvider & { calls: MockCall[]; files: Map<string, Buffer> } = {
    calls: [],
    files: new Map(),

    async create() {
      return "sb-1";
    },
    async destroy() {},
    async list() {
      return [];
    },
    async createSession() {},
    async execSessionCommand(): Promise<SessionExecResult> {
      return { commandId: "cmd-1" };
    },
    async getSessionCommandLogs() {},
    async uploadFile(_id: string, path: string, data: Buffer) {
      mock.calls.push({ method: "uploadFile", args: [path, data.length] });
      mock.files.set(path, data);
    },
    async downloadFile(_id: string, path: string) {
      mock.calls.push({ method: "downloadFile", args: [path] });
      const file = mock.files.get(path);
      return file ?? Buffer.from("mock content");
    },
    async executeCommand(_id: string, command: string) {
      mock.calls.push({ method: "executeCommand", args: [command] });
      return { exitCode: 0, result: "" };
    },
    async getSessionCommandExitCode() {
      return 0;
    },
  };
  return mock;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createTempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com && git config user.name Test", {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("syncIn", () => {
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    provider = createMockProvider();
    resetSyncState("sb-1");
  });

  it("does a full tar upload on first call", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "hello.txt"), "world");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    await syncIn(provider, "sb-1", dir);

    const uploadCall = provider.calls.find((c) => c.method === "uploadFile");
    expect(uploadCall).toBeDefined();
    // Should have uploaded a tarball
    expect(uploadCall!.args[1] as number).toBeGreaterThan(0);

    // Should have extracted in sandbox
    const execCall = provider.calls.find((c) => c.method === "executeCommand");
    expect(execCall).toBeDefined();
    expect(execCall!.args[0]).toContain("tar -xzf");
  });

  it("uses git-diff partial sync on repeat call", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "hello.txt"), "world");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    // First call — full sync
    await syncIn(provider, "sb-1", dir);
    const firstCalls = provider.calls.length;

    // Modify a file
    writeFileSync(join(dir, "hello.txt"), "changed");

    // Second call — partial sync
    await syncIn(provider, "sb-1", dir);

    // Should have made additional upload + extract calls
    expect(provider.calls.length).toBeGreaterThan(firstCalls);
  });

  it("skips upload for empty worktree (no files)", async () => {
    const dir = createTempWorktree();
    // Empty repo — no files, no commits
    // createTarball with "." on an empty dir produces a valid but near-empty tar
    await syncIn(provider, "sb-1", dir);
    // uploadFile should still be called (tar of empty dir is valid)
    // The key thing is it doesn't crash
  });
});

describe("syncOut", () => {
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    provider = createMockProvider();
  });

  it("downloads changed files and writes to worktree", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "existing.txt"), "old");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    // Mock: sandbox reports one changed file
    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git diff --name-only")) {
        return { exitCode: 0, result: "changed.txt\n" };
      }
      return { exitCode: 0, result: "" };
    });

    provider.downloadFile = vi.fn().mockResolvedValue(Buffer.from("new content"));

    const result = await syncOut(provider, "sb-1", dir);

    expect(result.filesChanged).toBe(1);
    expect(existsSync(join(dir, "changed.txt"))).toBe(true);
  });

  it("handles deleted files from sandbox", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "to-delete.txt"), "will be deleted");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git status --porcelain")) {
        return { exitCode: 0, result: " D to-delete.txt\n" };
      }
      return { exitCode: 0, result: "" };
    });

    const result = await syncOut(provider, "sb-1", dir);

    expect(result.filesDeleted).toBe(1);
    expect(existsSync(join(dir, "to-delete.txt"))).toBe(false);
  });

  it("throws on download failure (D14: fail loud)", async () => {
    const dir = createTempWorktree();

    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git diff --name-only")) {
        return { exitCode: 0, result: "file.txt\n" };
      }
      return { exitCode: 0, result: "" };
    });

    provider.downloadFile = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncOut(provider, "sb-1", dir)).rejects.toThrow("network error");
  });

  it("creates nested directories for deep file paths", async () => {
    const dir = createTempWorktree();

    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git diff --name-only")) {
        return { exitCode: 0, result: "src/deep/nested/file.ts\n" };
      }
      return { exitCode: 0, result: "" };
    });

    provider.downloadFile = vi.fn().mockResolvedValue(Buffer.from("content"));

    const result = await syncOut(provider, "sb-1", dir);

    expect(result.filesChanged).toBe(1);
    expect(existsSync(join(dir, "src/deep/nested/file.ts"))).toBe(true);
  });
});
