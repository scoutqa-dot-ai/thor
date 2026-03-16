import { describe, it, expect } from "vitest";
import { validateCwd, validateGitArgs, validateGhArgs } from "./policy.js";

// ── cwd validation ──────────────────────────────────────────────────────────

describe("validateCwd", () => {
  it("accepts paths under /workspace/repos", () => {
    expect(validateCwd("/workspace/repos/my-repo")).toBeNull();
    expect(validateCwd("/workspace/repos")).toBeNull();
  });

  it("accepts paths under /workspace/worktrees", () => {
    expect(validateCwd("/workspace/worktrees/my-repo/my-branch")).toBeNull();
    expect(validateCwd("/workspace/worktrees")).toBeNull();
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
  it("allows common git commands", () => {
    expect(validateGitArgs(["status"])).toBeNull();
    expect(validateGitArgs(["log", "--oneline", "-10"])).toBeNull();
    expect(validateGitArgs(["diff"])).toBeNull();
    expect(validateGitArgs(["push", "origin", "my-branch"])).toBeNull();
    expect(validateGitArgs(["commit", "-m", "fix typo"])).toBeNull();
    expect(validateGitArgs(["worktree", "add", "/workspace/worktrees/repo/branch"])).toBeNull();
    expect(validateGitArgs(["add", "-A"])).toBeNull();
    expect(validateGitArgs(["fetch", "origin"])).toBeNull();
  });

  it("blocks git clone", () => {
    expect(validateGitArgs(["clone", "https://github.com/foo/bar"])).not.toBeNull();
  });

  it("blocks git init", () => {
    expect(validateGitArgs(["init"])).not.toBeNull();
  });

  it("blocks clone even with flags before it", () => {
    expect(validateGitArgs(["-C", "/tmp", "clone", "https://github.com/foo/bar"])).not.toBeNull();
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
    it("allows pr subcommands", () => {
      expect(validateGhArgs(["pr", "view", "123"])).toBeNull();
      expect(validateGhArgs(["pr", "diff", "123"])).toBeNull();
      expect(validateGhArgs(["pr", "list"])).toBeNull();
      expect(validateGhArgs(["pr", "status"])).toBeNull();
      expect(validateGhArgs(["pr", "checks", "123"])).toBeNull();
      expect(validateGhArgs(["pr", "create", "--title", "foo"])).toBeNull();
      expect(validateGhArgs(["pr", "edit", "123"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "--body", "lgtm"])).toBeNull();
    });

    it("allows issue subcommands", () => {
      expect(validateGhArgs(["issue", "view", "42"])).toBeNull();
      expect(validateGhArgs(["issue", "list"])).toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--body", "noted"])).toBeNull();
    });

    it("allows repo view", () => {
      expect(validateGhArgs(["repo", "view"])).toBeNull();
    });

    it("allows run subcommands", () => {
      expect(validateGhArgs(["run", "list"])).toBeNull();
      expect(validateGhArgs(["run", "view", "12345"])).toBeNull();
    });

    it("allows workflow subcommands", () => {
      expect(validateGhArgs(["workflow", "list"])).toBeNull();
      expect(validateGhArgs(["workflow", "view", "ci.yml"])).toBeNull();
    });

    it("allows release subcommands", () => {
      expect(validateGhArgs(["release", "list"])).toBeNull();
      expect(validateGhArgs(["release", "view", "v1.0"])).toBeNull();
      expect(validateGhArgs(["release", "download", "v1.0"])).toBeNull();
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

    it("requires a subcommand", () => {
      expect(validateGhArgs(["pr"])).not.toBeNull();
    });

    it("rejects empty args", () => {
      expect(validateGhArgs([])).not.toBeNull();
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
});
