import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";

// Mock execFile before importing provider
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock @daytonaio/sdk
const mockSandbox = {
  id: "sb-1",
  fs: {
    uploadFile: vi.fn(),
  },
  process: {
    executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: "" }),
  },
  createSshAccess: vi.fn().mockResolvedValue({
    token: "test-token",
    sshCommand: "ssh test-token@ssh.test.daytona.io",
    expiresAt: new Date(Date.now() + 3600_000),
  }),
};

vi.mock("@daytonaio/sdk", () => {
  class MockDaytona {
    constructor(_opts: unknown) {}
    get = vi.fn().mockResolvedValue(mockSandbox);
    create = vi.fn().mockResolvedValue(mockSandbox);
    delete = vi.fn();
    list = vi.fn().mockResolvedValue({ items: [] });
  }
  return { Daytona: MockDaytona };
});

// Must import after mocks are set up
import { DaytonaSandboxProvider } from "./provider.js";

const mockedExecFile = vi.mocked(execFile);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DaytonaSandboxProvider sync", () => {
  let provider: DaytonaSandboxProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DaytonaSandboxProvider("test-api-key");

    // Reset mock sandbox defaults
    mockSandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: "" });
    mockSandbox.createSshAccess.mockResolvedValue({
      token: "test-token",
      sshCommand: "ssh test-token@ssh.test.daytona.io",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // Default: rsync succeeds
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      if (typeof callback === "function") {
        (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, "", "");
      }
      return {} as ReturnType<typeof execFile>;
    });
  });

  describe("syncIn", () => {
    it("calls rsync with correct args including gitignore filter", async () => {
      await provider.syncIn("sb-1", "/workspace/src");

      // Find the rsync call
      const rsyncCall = mockedExecFile.mock.calls.find((c) => c[0] === "rsync");
      expect(rsyncCall).toBeDefined();

      const args = rsyncCall![1] as string[];
      expect(args).toContain("-azq");
      expect(args).toContain("--delete");
      expect(args).toContain("--filter=:- .gitignore");
      expect(args).toContain("--exclude");
      expect(args).toContain(".git");
      // Source should end with /
      expect(args.find((a) => a.startsWith("/workspace/src/"))).toBeDefined();
      // Destination should use SSH credentials
      expect(args.find((a) => a.includes("test-token@ssh.test.daytona.io"))).toBeDefined();
    });

    it("runs git init on first sync", async () => {
      await provider.syncIn("sb-1", "/workspace/src");

      // Should have called executeCommand for mkdir and git init
      const execCalls = mockSandbox.process.executeCommand.mock.calls;
      const gitInitCall = execCalls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("git init"),
      );
      expect(gitInitCall).toBeDefined();
      expect(gitInitCall![0]).toContain("git add -A");
      expect(gitInitCall![0]).toContain("git commit -m sync");
    });

    it("skips git init on repeat syncs", async () => {
      await provider.syncIn("sb-1", "/workspace/src");
      mockSandbox.process.executeCommand.mockClear();

      await provider.syncIn("sb-1", "/workspace/src");

      // No mkdir or git init on second call
      const execCalls = mockSandbox.process.executeCommand.mock.calls;
      const gitInitCall = execCalls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("git init"),
      );
      expect(gitInitCall).toBeUndefined();
    });

    it("creates target directory on first sync", async () => {
      await provider.syncIn("sb-1", "/workspace/src");

      const execCalls = mockSandbox.process.executeCommand.mock.calls;
      const mkdirCall = execCalls.find(
        (c: string[]) => typeof c[0] === "string" && c[0].includes("mkdir -p"),
      );
      expect(mkdirCall).toBeDefined();
    });

    it("throws if rsync fails", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        if (typeof callback === "function") {
          const err = new Error("rsync error") as Error & { code: number };
          err.code = 1;
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(
            err,
            "",
            "connection refused",
          );
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(provider.syncIn("sb-1", "/workspace/src")).rejects.toThrow("rsync failed");
    });
  });

  describe("syncOut", () => {
    it("calls rsync with correct args (no gitignore filter)", async () => {
      await provider.syncIn("sb-1", "/workspace/src"); // need first sync for SSH cache
      mockedExecFile.mockClear();

      // Re-setup rsync mock after clear
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        if (typeof callback === "function") {
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      });

      await provider.syncOut("sb-1", "/workspace/src");

      const rsyncCall = mockedExecFile.mock.calls.find((c) => c[0] === "rsync");
      expect(rsyncCall).toBeDefined();

      const args = rsyncCall![1] as string[];
      expect(args).toContain("-azq");
      expect(args).toContain("--delete");
      expect(args).toContain("--exclude");
      expect(args).toContain(".git");
      // Should NOT have gitignore filter on syncOut (D28)
      expect(args).not.toContain("--filter=:- .gitignore");
      // Source is remote, destination is local
      expect(args.find((a) => a.includes("test-token@ssh.test.daytona.io"))).toBeDefined();
      expect(args.find((a) => a.startsWith("/workspace/src/"))).toBeDefined();
    });

    it("returns file counts from git status", async () => {
      // Mock git commands for change detection
      mockSandbox.process.executeCommand
        .mockResolvedValueOnce({ exitCode: 0, result: "" }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, result: "" }) // git init
        .mockResolvedValueOnce({
          exitCode: 0,
          result: "modified.txt\nnew-file.txt\ndeleted.txt\n",
        }) // git diff + ls-files
        .mockResolvedValueOnce({
          exitCode: 0,
          result: " D deleted.txt\n",
        }); // git status --porcelain

      await provider.syncIn("sb-1", "/workspace/src");
      const result = await provider.syncOut("sb-1", "/workspace/src");

      expect(result.filesChanged).toBe(2); // modified + new, minus deleted
      expect(result.filesDeleted).toBe(1);
    });
  });

  describe("SSH credential caching", () => {
    it("reuses cached SSH credentials", async () => {
      await provider.syncIn("sb-1", "/workspace/src");
      await provider.syncIn("sb-1", "/workspace/src");

      // createSshAccess should only be called once
      expect(mockSandbox.createSshAccess).toHaveBeenCalledTimes(1);
    });

    it("refreshes expired SSH credentials", async () => {
      // First call: token expiring in 2 minutes (within 5-min refresh buffer)
      mockSandbox.createSshAccess.mockResolvedValueOnce({
        token: "old-token",
        sshCommand: "ssh old-token@ssh.test.daytona.io",
        expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2 min from now
      });

      await provider.syncIn("sb-1", "/workspace/src");

      // Second call should refresh
      mockSandbox.createSshAccess.mockResolvedValueOnce({
        token: "new-token",
        sshCommand: "ssh new-token@ssh.test.daytona.io",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await provider.syncIn("sb-1", "/workspace/src");

      expect(mockSandbox.createSshAccess).toHaveBeenCalledTimes(2);
    });

    it("parses host from sshCommand (D33)", async () => {
      mockSandbox.createSshAccess.mockResolvedValueOnce({
        token: "tok",
        sshCommand: "ssh tok@custom-ssh.example.com",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await provider.syncIn("sb-1", "/workspace/src");

      const rsyncCall = mockedExecFile.mock.calls.find((c) => c[0] === "rsync");
      const args = rsyncCall![1] as string[];
      expect(args.find((a) => a.includes("tok@custom-ssh.example.com"))).toBeDefined();
    });

    it("throws if sshCommand cannot be parsed", async () => {
      mockSandbox.createSshAccess.mockResolvedValueOnce({
        token: "tok",
        sshCommand: "invalid-format",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await expect(provider.syncIn("sb-1", "/workspace/src")).rejects.toThrow(
        "Could not parse SSH host",
      );
    });
  });
});
