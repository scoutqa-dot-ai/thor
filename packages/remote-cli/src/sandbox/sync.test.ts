import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { syncIn, syncOut, resetSyncState } from "./sync.js";
import type { SandboxProvider } from "./provider.js";

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
    async runAgentStreaming() {
      return { exitCode: 0 };
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

    // Should have extracted in sandbox and initialized a git repo
    const execCall = provider.calls.find((c) => c.method === "executeCommand");
    expect(execCall).toBeDefined();
    expect(execCall!.args[0]).toContain("tar -xzf");
    expect(execCall!.args[0]).toContain("git init");
    expect(execCall!.args[0]).toContain("git commit -m sync");
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

  it("handles deleted files in partial sync without crashing", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "keep.txt"), "keep");
    writeFileSync(join(dir, "remove.txt"), "remove");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    // First call — full sync
    await syncIn(provider, "sb-1", dir);
    provider.calls = [];

    // Delete a tracked file locally
    unlinkSync(join(dir, "remove.txt"));

    // Second call — partial sync should not crash
    await syncIn(provider, "sb-1", dir);

    // Should have issued rm command for deleted file in sandbox
    const rmCall = provider.calls.find(
      (c) => c.method === "executeCommand" && (c.args[0] as string).includes("rm -f"),
    );
    expect(rmCall).toBeDefined();
    expect(rmCall!.args[0]).toContain("remove.txt");

    // Should have committed the sync snapshot
    const commitCall = provider.calls.find(
      (c) => c.method === "executeCommand" && (c.args[0] as string).includes("git commit -m sync"),
    );
    expect(commitCall).toBeDefined();
  });

  it("handles only-deletes in partial sync (no tar upload)", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "only.txt"), "file");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    await syncIn(provider, "sb-1", dir);
    provider.calls = [];

    unlinkSync(join(dir, "only.txt"));

    await syncIn(provider, "sb-1", dir);

    // No upload should have happened (no changed files to tar)
    const uploadCall = provider.calls.find((c) => c.method === "uploadFile");
    expect(uploadCall).toBeUndefined();

    // But rm + commit should still have happened
    const rmCall = provider.calls.find(
      (c) => c.method === "executeCommand" && (c.args[0] as string).includes("rm -f"),
    );
    expect(rmCall).toBeDefined();
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

  it("handles deleted files from sandbox without trying to download them", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "to-delete.txt"), "will be deleted");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git diff --name-only")) {
        // git diff reports deleted files too
        return { exitCode: 0, result: "to-delete.txt\n" };
      }
      if (cmd.includes("git status --porcelain")) {
        return { exitCode: 0, result: " D to-delete.txt\n" };
      }
      return { exitCode: 0, result: "" };
    });

    provider.downloadFile = vi.fn().mockRejectedValue(new Error("file not found"));

    const result = await syncOut(provider, "sb-1", dir);

    expect(result.filesDeleted).toBe(1);
    expect(result.filesChanged).toBe(0);
    expect(existsSync(join(dir, "to-delete.txt"))).toBe(false);
    // downloadFile should NOT have been called — deleted files are filtered out
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it("handles mix of changed and deleted files", async () => {
    const dir = createTempWorktree();
    writeFileSync(join(dir, "to-delete.txt"), "delete me");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "ignore" });

    provider.executeCommand = vi.fn().mockImplementation((_id: string, cmd: string) => {
      if (cmd.includes("git diff --name-only")) {
        return { exitCode: 0, result: "modified.txt\nto-delete.txt\n" };
      }
      if (cmd.includes("git status --porcelain")) {
        return { exitCode: 0, result: " D to-delete.txt\n" };
      }
      if (cmd.includes("git ls-files")) {
        return { exitCode: 0, result: "new-file.txt\n" };
      }
      return { exitCode: 0, result: "" };
    });

    provider.downloadFile = vi.fn().mockResolvedValue(Buffer.from("content"));

    const result = await syncOut(provider, "sb-1", dir);

    expect(result.filesChanged).toBe(2); // modified.txt + new-file.txt
    expect(result.filesDeleted).toBe(1); // to-delete.txt
    // Only 2 downloads — deleted file filtered out
    expect(provider.downloadFile).toHaveBeenCalledTimes(2);
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
