import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxManager } from "./manager.js";
import type { SandboxProvider, SandboxInfo, SessionExecResult } from "./provider.js";

// ── Mock provider ───────────────────────────────────────────────────────────

interface MockProvider extends SandboxProvider {
  createCalls: number;
  destroyed: string[];
  listed: SandboxInfo[];
}

function createMockProvider(): MockProvider {
  let nextId = 1;
  const mock: MockProvider = {
    createCalls: 0,
    destroyed: [],
    listed: [],

    async create() {
      mock.createCalls++;
      // Simulate some async delay to test locking
      await new Promise((r) => setTimeout(r, 10));
      return `sandbox-${nextId++}`;
    },
    async destroy(sandboxId: string) {
      mock.destroyed.push(sandboxId);
    },
    async list() {
      return mock.listed;
    },
    async createSession() {},
    async execSessionCommand(): Promise<SessionExecResult> {
      return { commandId: "cmd-1" };
    },
    async getSessionCommandLogs() {},
    async uploadFile() {},
    async downloadFile() {
      return Buffer.from("");
    },
    async executeCommand() {
      return { exitCode: 0, result: "" };
    },
  };
  return mock;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SandboxManager", () => {
  let provider: MockProvider;
  let manager: SandboxManager;

  beforeEach(() => {
    provider = createMockProvider();
    manager = new SandboxManager(provider);
  });

  describe("getOrCreate", () => {
    it("creates a new sandbox on first call", async () => {
      const id = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id).toBe("sandbox-1");
      expect(provider.createCalls).toBe(1);
    });

    it("returns cached sandbox on second call", async () => {
      const id1 = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      const id2 = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id1).toBe(id2);
      expect(provider.createCalls).toBe(1);
    });

    it("creates separate sandboxes for different worktrees", async () => {
      const id1 = await manager.getOrCreate("/workspace/worktrees/repo/branch-a");
      const id2 = await manager.getOrCreate("/workspace/worktrees/repo/branch-b");
      expect(id1).not.toBe(id2);
      expect(provider.createCalls).toBe(2);
    });

    it("deduplicates concurrent calls for the same worktree (D9 lock)", async () => {
      const cwd = "/workspace/worktrees/repo/branch";
      // Fire two concurrent calls
      const [id1, id2] = await Promise.all([manager.getOrCreate(cwd), manager.getOrCreate(cwd)]);
      expect(id1).toBe(id2);
      // Only one provider.create call should have been made
      expect(provider.createCalls).toBe(1);
    });
  });

  describe("destroy", () => {
    it("removes sandbox from cache and calls provider.destroy", async () => {
      const cwd = "/workspace/worktrees/repo/branch";
      await manager.getOrCreate(cwd);
      await manager.destroy(cwd);

      expect(provider.destroyed).toContain("sandbox-1");
      // After destroy, getOrCreate should create a new one
      const id = await manager.getOrCreate(cwd);
      expect(id).toBe("sandbox-2");
    });

    it("is a no-op for unknown worktrees", async () => {
      await manager.destroy("/workspace/worktrees/nonexistent");
      expect(provider.destroyed).toHaveLength(0);
    });

    it("does not throw if provider.destroy fails", async () => {
      const cwd = "/workspace/worktrees/repo/branch";
      await manager.getOrCreate(cwd);
      provider.destroy = vi.fn().mockRejectedValue(new Error("Daytona API down"));
      // Should not throw
      await manager.destroy(cwd);
    });
  });

  describe("reconcile", () => {
    it("destroys orphaned sandboxes (worktree path does not exist)", async () => {
      provider.listed = [
        { id: "orphan-1", labels: { thor: "true", worktree: "/workspace/worktrees/gone/branch" } },
      ];
      await manager.reconcile();
      expect(provider.destroyed).toContain("orphan-1");
    });

    it("restores sandboxes with existing worktree paths", async () => {
      // Use a path that exists on the filesystem
      const existingPath = "/tmp";
      provider.listed = [{ id: "live-1", labels: { thor: "true", worktree: existingPath } }];
      await manager.reconcile();
      expect(manager.get(existingPath)).toBe("live-1");
      expect(provider.destroyed).not.toContain("live-1");
    });

    it("destroys sandboxes with missing worktree label", async () => {
      provider.listed = [{ id: "unlabeled-1", labels: { thor: "true" } }];
      await manager.reconcile();
      expect(provider.destroyed).toContain("unlabeled-1");
    });

    it("does not throw if provider.list fails (non-fatal)", async () => {
      provider.list = vi.fn().mockRejectedValue(new Error("Daytona unreachable"));
      // Should not throw — logs warning and continues
      await manager.reconcile();
    });
  });
});
