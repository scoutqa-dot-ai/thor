import { describe, expect, it } from "vitest";

const { SandboxIdentitySchema, SandboxPreviewSchema, SandboxRecordSchema } =
  await import("./sandboxes.js");

describe("sandboxes", () => {
  it("parses a valid worktree identity", () => {
    expect(
      SandboxIdentitySchema.parse({
        worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
        repo: "acme-api",
        branch: "feat-sandbox",
      }),
    ).toMatchObject({
      worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
      repo: "acme-api",
      branch: "feat-sandbox",
    });
  });

  it("requires a valid preview URL", () => {
    expect(() =>
      SandboxPreviewSchema.parse({
        url: "not-a-url",
      }),
    ).toThrow();
  });

  it("parses a valid sandbox record", () => {
    expect(
      SandboxRecordSchema.parse({
        version: 1,
        provider: "daytona",
        sandboxId: "sbx-123",
        identity: {
          worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
          repo: "acme-api",
          branch: "feat-sandbox",
        },
        status: "ready",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        preview: {
          url: "https://preview.example.com",
        },
      }),
    ).toMatchObject({
      sandboxId: "sbx-123",
      status: "ready",
    });
  });

  it("defaults metadata to an empty object", () => {
    const record = SandboxRecordSchema.parse({
      version: 1,
      provider: "daytona",
      sandboxId: "sbx-123",
      identity: {
        worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
      },
      status: "ready",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
    });

    expect(record.metadata).toEqual({});
  });

  it("rejects records without a worktree path", () => {
    expect(() =>
      SandboxRecordSchema.parse({
        version: 1,
        provider: "daytona",
        sandboxId: "sbx-123",
        identity: {},
        status: "ready",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects unsupported sandbox states", () => {
    expect(() =>
      SandboxRecordSchema.parse({
        version: 1,
        provider: "daytona",
        sandboxId: "sbx-123",
        identity: {
          worktreePath: "/workspace/worktrees/acme-api/feat-sandbox",
        },
        status: "deleted",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
