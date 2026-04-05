import { describe, it, expect } from "vitest";
import { validateCwd, validateGitArgs, validateGhArgs } from "./policy.js";

// ── cwd validation ──────────────────────────────────────────────────────────

describe("validateCwd", () => {
  it("accepts paths under /workspace/repos", () => {
    expect(validateCwd("/workspace/repos/my-repo")).toBeNull();
  });

  it("accepts paths under /workspace/worktrees", () => {
    expect(validateCwd("/workspace/worktrees/my-repo/my-branch")).toBeNull();
  });

  it("rejects relative paths", () => {
    expect(validateCwd("workspace/repos/foo")).not.toBeNull();
    expect(validateCwd("./workspace/repos/foo")).not.toBeNull();
  });

  it("rejects empty or missing cwd", () => {
    expect(validateCwd("")).not.toBeNull();
    expect(validateCwd(undefined as unknown as string)).not.toBeNull();
  });

  it("rejects paths outside allowed prefixes", () => {
    expect(validateCwd("/tmp")).not.toBeNull();
    expect(validateCwd("/workspace/memory")).not.toBeNull();
    expect(validateCwd("/workspace/reposevil")).not.toBeNull();
  });

  it("rejects traversal attempts", () => {
    expect(validateCwd("/workspace/repos/../../etc/passwd")).not.toBeNull();
    expect(validateCwd("/workspace/worktrees/../../../tmp")).not.toBeNull();
  });
});

// ── git policy ──────────────────────────────────────────────────────────────

describe("validateGitArgs", () => {
  describe("allowed commands", () => {
    it("allows a representative read command", () => {
      expect(validateGitArgs(["status"])).toBeNull();
    });

    it("allows push to origin", () => {
      expect(validateGitArgs(["push", "origin", "my-branch"])).toBeNull();
    });

    it("allows worktree add under /workspace/worktrees/", () => {
      expect(
        validateGitArgs(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat"]),
      ).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks git clone", () => {
      expect(validateGitArgs(["clone", "https://github.com/foo/bar"])).not.toBeNull();
    });

    it("blocks git init", () => {
      expect(validateGitArgs(["init"])).not.toBeNull();
    });

    it("blocks clone even with flags before it", () => {
      expect(validateGitArgs(["-C", "/tmp", "clone", "https://github.com/foo/bar"])).not.toBeNull();
    });

    it("blocks checkout and switch (agent stays on assigned branch)", () => {
      expect(validateGitArgs(["checkout", "main"])).not.toBeNull();
      expect(validateGitArgs(["switch", "feature"])).not.toBeNull();
    });

    it("blocks worktree add outside /workspace/worktrees/", () => {
      expect(validateGitArgs(["worktree", "add", "/tmp/evil"])).not.toBeNull();
      expect(validateGitArgs(["worktree", "add", "/workspace/repos/sneaky"])).not.toBeNull();
      expect(
        validateGitArgs(["worktree", "add", "/workspace/worktrees/../repos/escape"]),
      ).not.toBeNull();
    });

    it("allows worktree paths with nested branch names", () => {
      expect(
        validateGitArgs(["worktree", "add", "/workspace/worktrees/repo/feat/my-feature"]),
      ).toBeNull();
    });

    it("blocks git remote add/set-url/rename/remove", () => {
      expect(
        validateGitArgs(["remote", "add", "evil", "https://evil.com/repo.git"]),
      ).not.toBeNull();
      expect(
        validateGitArgs(["remote", "set-url", "origin", "https://evil.com/repo.git"]),
      ).not.toBeNull();
      expect(validateGitArgs(["remote", "rename", "origin", "old"])).not.toBeNull();
      expect(validateGitArgs(["remote", "remove", "origin"])).not.toBeNull();
      expect(validateGitArgs(["remote", "prune", "origin"])).not.toBeNull();
    });

    it("blocks push to non-origin remotes", () => {
      expect(validateGitArgs(["push", "evil", "main"])).not.toBeNull();
      expect(validateGitArgs(["push", "https://evil.com/repo.git", "main"])).not.toBeNull();
      expect(validateGitArgs(["push", "upstream", "main"])).not.toBeNull();
    });

    it("blocks arbitrary commands", () => {
      expect(validateGitArgs(["fsck"])).not.toBeNull();
      expect(validateGitArgs(["gc"])).not.toBeNull();
      expect(validateGitArgs(["daemon"])).not.toBeNull();
    });
  });

  it("rejects empty args", () => {
    expect(validateGitArgs([])).not.toBeNull();
  });

  it("rejects non-array", () => {
    expect(validateGitArgs("status" as unknown as string[])).not.toBeNull();
  });

  it("rejects args with no subcommand (only flags)", () => {
    expect(validateGitArgs(["--version"])).not.toBeNull();
  });
});

// ── gh policy ───────────────────────────────────────────────────────────────

describe("validateGhArgs", () => {
  describe("allowed commands", () => {
    it("allows representative read and write-safe gh commands", () => {
      expect(validateGhArgs(["pr", "view", "123"])).toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--body", "noted"])).toBeNull();
      expect(validateGhArgs(["repo", "view"])).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks pr merge", () => {
      expect(validateGhArgs(["pr", "merge", "123"])).not.toBeNull();
    });

    it("blocks repo create", () => {
      expect(validateGhArgs(["repo", "create", "foo"])).not.toBeNull();
    });

    it("blocks repo delete", () => {
      expect(validateGhArgs(["repo", "delete", "foo"])).not.toBeNull();
    });

    it("blocks auth commands", () => {
      expect(validateGhArgs(["auth", "login"])).not.toBeNull();
    });

    it("blocks secret commands", () => {
      expect(validateGhArgs(["secret", "set", "FOO"])).not.toBeNull();
    });
  });

  describe("gh api", () => {
    it("blocks gh api entirely", () => {
      expect(validateGhArgs(["api", "repos/org/repo/pulls"])).not.toBeNull();
      expect(validateGhArgs(["api", "-X", "GET", "repos/org/repo"])).not.toBeNull();
      expect(validateGhArgs(["api", "-X", "POST", "repos/org/repo/pulls"])).not.toBeNull();
      expect(validateGhArgs(["api", "graphql"])).not.toBeNull();
    });
  });

  it("requires non-empty args with a subcommand", () => {
    expect(validateGhArgs(["pr"])).not.toBeNull();
    expect(validateGhArgs([])).not.toBeNull();
  });
});
