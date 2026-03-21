import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getRemoteExecutionDir,
  parseWorktreeMetadata,
  resolveWorktreeContext,
} from "./worktree.js";

describe("resolveWorktreeContext", () => {
  it("resolves the containing git worktree and focus path", () => {
    const root = mkdtempSync(join(tmpdir(), "thor-sandboxd-worktree-"));

    try {
      mkdirSync(join(root, "packages", "runner"), { recursive: true });
      writeFileSync(join(root, ".git"), "gitdir: /tmp/fake.git\n");

      const context = resolveWorktreeContext(join(root, "packages", "runner"));

      expect(context.worktreePath).toBe(realpathSync(root));
      expect(context.focusPath).toBe("packages/runner");
      expect(context.repo).toBe(root.split("/").at(-1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the remote workspace dir when there is no focus path", () => {
    const root = mkdtempSync(join(tmpdir(), "thor-sandboxd-worktree-"));

    try {
      writeFileSync(join(root, ".git"), "gitdir: /tmp/fake.git\n");

      const context = resolveWorktreeContext(root);

      expect(getRemoteExecutionDir(context)).toMatch(/^\/tmp\/thor-worktree-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseWorktreeMetadata", () => {
  it("extracts repo and branch from the container worktree convention", () => {
    expect(parseWorktreeMetadata("/workspace/worktrees/acme-api/feat/sandbox")).toEqual({
      repo: "acme-api",
      branch: "feat/sandbox",
    });
  });

  it("falls back to the worktree basename outside the container path", () => {
    expect(parseWorktreeMetadata("/Users/example/worktrees/rome-v4")).toEqual({
      repo: "rome-v4",
    });
  });
});
