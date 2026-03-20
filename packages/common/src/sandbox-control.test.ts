import { describe, expect, it, vi } from "vitest";

import type {
  SandboxExecRequest,
  SandboxIdentity,
  SandboxMaterializeRequest,
  SandboxPreview,
  SandboxProvider,
  SandboxRecord,
} from "./sandboxes.js";

const { SandboxProviderError, ensureSandboxForWorktree, destroySandboxForWorktree } =
  await import("./sandbox-control.js");

describe("sandbox control", () => {
  const identity: SandboxIdentity = {
    worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
    repo: "acme-api",
    branch: "feat/sandbox",
  };

  it("creates and materializes a sandbox when no sandbox exists", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(createRecord(identity, "sandbox-created", "creating")),
    });

    const result = await ensureSandboxForWorktree(provider, identity);

    expect(result.action).toBe("created");
    expect(result.materialized).toBe(true);
    expect(result.record.sandboxId).toBe("sandbox-created");
    expect(provider.materializeWorkspace).toHaveBeenCalledWith("sandbox-created", {
      worktreePath: identity.worktreePath,
    });
  });

  it("resumes a stopped sandbox without rematerializing by default", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi
        .fn()
        .mockResolvedValue(createRecord(identity, "sandbox-stopped", "stopped")),
      resume: vi.fn().mockResolvedValue(createRecord(identity, "sandbox-stopped", "ready")),
    });

    const result = await ensureSandboxForWorktree(provider, identity);

    expect(result.action).toBe("resumed");
    expect(result.materialized).toBe(false);
    expect(provider.resume).toHaveBeenCalledWith("sandbox-stopped");
    expect(provider.materializeWorkspace).not.toHaveBeenCalled();
  });

  it("reuses an active sandbox and can rematerialize on demand", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi.fn().mockResolvedValue(createRecord(identity, "sandbox-ready", "ready")),
    });

    const result = await ensureSandboxForWorktree(provider, identity, {
      materialize: "always",
      materializeRequest: { includeUncommitted: true },
    });

    expect(result.action).toBe("reused");
    expect(result.materialized).toBe(true);
    expect(provider.materializeWorkspace).toHaveBeenCalledWith("sandbox-ready", {
      worktreePath: identity.worktreePath,
      includeUncommitted: true,
    });
  });

  it("wraps provider failures with the operation context", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });

    await expect(ensureSandboxForWorktree(provider, identity)).rejects.toMatchObject({
      name: "SandboxProviderError",
      providerName: "daytona",
      operation: "lookup",
      message: "daytona sandbox lookup failed: provider unavailable",
    });
  });

  it("destroys the sandbox attached to a worktree", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi.fn().mockResolvedValue(createRecord(identity, "sandbox-ready", "ready")),
    });

    await expect(destroySandboxForWorktree(provider, identity)).resolves.toBe(true);
    expect(provider.destroy).toHaveBeenCalledWith("sandbox-ready");
  });

  it("returns false when there is no sandbox to destroy", async () => {
    const provider = createFakeProvider({
      findByWorktree: vi.fn().mockResolvedValue(undefined),
    });

    await expect(destroySandboxForWorktree(provider, identity)).resolves.toBe(false);
    expect(provider.destroy).not.toHaveBeenCalled();
  });
});

function createFakeProvider(
  overrides: Partial<Record<keyof SandboxProvider, unknown>> = {},
): SandboxProvider & {
  findByWorktree: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  materializeWorkspace: ReturnType<typeof vi.fn>;
  exportWorkspace: ReturnType<typeof vi.fn>;
  getPreview: ReturnType<typeof vi.fn>;
} {
  return {
    providerName: "daytona",
    findByWorktree: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(createRecord({ worktreePath: "/tmp/repo" }, "sandbox-1")),
    get: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(createRecord({ worktreePath: "/tmp/repo" }, "sandbox-1")),
    destroy: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
    materializeWorkspace: vi.fn().mockResolvedValue(undefined),
    exportWorkspace: vi
      .fn()
      .mockResolvedValue({ filesChanged: 0, filesDeleted: 0, artifactPaths: [] }),
    getPreview: vi.fn().mockResolvedValue({ url: "https://preview.example.com" }),
    ...overrides,
  };
}

function createRecord(
  identity: SandboxIdentity,
  sandboxId: string,
  status: SandboxRecord["status"] = "ready",
): SandboxRecord {
  return {
    version: 1,
    provider: "daytona",
    sandboxId,
    identity,
    status,
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    metadata: {},
  };
}
