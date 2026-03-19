import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxManager } from "./manager.js";
import type { SandboxProvider, SandboxInfo, SessionExecResult } from "./provider.js";

// ── Mock provider ───────────────────────────────────────────────────────────

interface MockProvider extends SandboxProvider {
  createCalls: number;
  destroyed: string[];
  listed: SandboxInfo[];
  snapshotAvailable: string | null;
}

function createMockProvider(): MockProvider {
  let nextId = 1;
  const mock: MockProvider = {
    createCalls: 0,
    destroyed: [],
    listed: [],
    snapshotAvailable: null,

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
    async createSnapshot() {
      return "snapshot-1";
    },
    async getSnapshot() {
      return mock.snapshotAvailable;
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
    it("creates a new sandbox when none exists remotely", async () => {
      const id = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id).toBe("sandbox-1");
      expect(provider.createCalls).toBe(1);
    });

    it("returns existing sandbox found remotely", async () => {
      provider.listed = [
        { id: "remote-1", labels: { thor: "true", worktree: "/workspace/worktrees/repo/branch" } },
      ];
      const id = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id).toBe("remote-1");
      expect(provider.createCalls).toBe(0);
    });

    it("creates separate sandboxes for different worktrees", async () => {
      const id1 = await manager.getOrCreate("/workspace/worktrees/repo/branch-a");
      const id2 = await manager.getOrCreate("/workspace/worktrees/repo/branch-b");
      expect(id1).not.toBe(id2);
      expect(provider.createCalls).toBe(2);
    });

    it("uses snapshot when available (D15 warm start)", async () => {
      provider.snapshotAvailable = "thor-main-baseline";
      const id = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id).toBe("sandbox-1");
      expect(provider.createCalls).toBe(1);
    });

    it("falls back to image when snapshot create fails", async () => {
      provider.snapshotAvailable = "thor-main-baseline";
      let callCount = 0;
      const origCreate = provider.create.bind(provider);
      provider.create = vi.fn().mockImplementation(async (opts) => {
        callCount++;
        if (callCount === 1 && opts.snapshot) {
          throw new Error("snapshot unavailable");
        }
        return origCreate(opts);
      });
      const id = await manager.getOrCreate("/workspace/worktrees/repo/branch");
      expect(id).toBeDefined();
      // Two create calls: first snapshot (failed), then image (succeeded)
      expect(provider.create).toHaveBeenCalledTimes(2);
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

  describe("find", () => {
    it("returns sandbox ID when found remotely", async () => {
      provider.listed = [
        { id: "found-1", labels: { thor: "true", worktree: "/workspace/worktrees/repo/branch" } },
      ];
      const id = await manager.find("/workspace/worktrees/repo/branch");
      expect(id).toBe("found-1");
    });

    it("returns undefined when no sandbox exists", async () => {
      const id = await manager.find("/workspace/worktrees/repo/branch");
      expect(id).toBeUndefined();
    });

    it("returns undefined if provider.list fails (non-fatal)", async () => {
      provider.list = vi.fn().mockRejectedValue(new Error("Daytona unreachable"));
      const id = await manager.find("/workspace/worktrees/repo/branch");
      expect(id).toBeUndefined();
    });
  });

  describe("destroy", () => {
    it("finds and destroys sandbox remotely", async () => {
      provider.listed = [
        { id: "doomed-1", labels: { thor: "true", worktree: "/workspace/worktrees/repo/branch" } },
      ];
      await manager.destroy("/workspace/worktrees/repo/branch");
      expect(provider.destroyed).toContain("doomed-1");
    });

    it("is a no-op when no sandbox exists remotely", async () => {
      await manager.destroy("/workspace/worktrees/nonexistent");
      expect(provider.destroyed).toHaveLength(0);
    });

    it("does not throw if provider.destroy fails", async () => {
      provider.listed = [
        { id: "doomed-2", labels: { thor: "true", worktree: "/workspace/worktrees/repo/branch" } },
      ];
      const origList = provider.list.bind(provider);
      provider.list = origList;
      provider.destroy = vi.fn().mockRejectedValue(new Error("Daytona API down"));
      // Should not throw
      await manager.destroy("/workspace/worktrees/repo/branch");
    });
  });
});
