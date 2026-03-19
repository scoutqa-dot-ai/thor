import { describe, it, expect } from "vitest";
import {
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateSandboxCwd,
  validateSandboxCoderArgs,
} from "./policy.js";

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
  describe("allowed commands", () => {
    it("allows read commands", () => {
      expect(validateGitArgs(["status"])).toBeNull();
      expect(validateGitArgs(["log", "--oneline", "-10"])).toBeNull();
      expect(validateGitArgs(["diff"])).toBeNull();
      expect(validateGitArgs(["show", "HEAD"])).toBeNull();
      expect(validateGitArgs(["branch", "-a"])).toBeNull();
      expect(validateGitArgs(["blame", "file.ts"])).toBeNull();
      expect(validateGitArgs(["rev-parse", "HEAD"])).toBeNull();
      expect(validateGitArgs(["ls-files"])).toBeNull();
      expect(validateGitArgs(["grep", "TODO"])).toBeNull();
      expect(validateGitArgs(["submodule", "status"])).toBeNull();
    });

    it("allows write commands", () => {
      expect(validateGitArgs(["add", "-A"])).toBeNull();
      expect(validateGitArgs(["commit", "-m", "fix typo"])).toBeNull();
      expect(validateGitArgs(["merge", "main"])).toBeNull();
      expect(validateGitArgs(["rebase", "main"])).toBeNull();
      expect(validateGitArgs(["cherry-pick", "abc123"])).toBeNull();
      expect(validateGitArgs(["revert", "abc123"])).toBeNull();
      expect(validateGitArgs(["reset", "HEAD~1"])).toBeNull();
      expect(validateGitArgs(["restore", "file.ts"])).toBeNull();
      expect(validateGitArgs(["stash"])).toBeNull();
    });

    it("allows remote commands", () => {
      expect(validateGitArgs(["fetch", "origin"])).toBeNull();
      expect(validateGitArgs(["pull"])).toBeNull();
      expect(validateGitArgs(["push", "origin", "my-branch"])).toBeNull();
      expect(validateGitArgs(["remote", "-v"])).toBeNull();
    });

    it("allows worktree add under /workspace/worktrees/", () => {
      expect(validateGitArgs(["worktree", "add", "/workspace/worktrees/repo/branch"])).toBeNull();
      expect(
        validateGitArgs(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat"]),
      ).toBeNull();
    });

    it("allows worktree list/remove/prune", () => {
      expect(validateGitArgs(["worktree", "list"])).toBeNull();
      expect(validateGitArgs(["worktree", "remove", "/workspace/worktrees/repo/old"])).toBeNull();
      expect(validateGitArgs(["worktree", "prune"])).toBeNull();
    });

    it("allows subcommand after flags", () => {
      expect(validateGitArgs(["-C", "/workspace/repos/foo", "status"])).toBeNull();
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

// ── sandbox-coder policy ────────────────────────────────────────────────────

describe("validateSandboxCwd", () => {
  it("accepts paths under /workspace/worktrees/", () => {
    expect(validateSandboxCwd("/workspace/worktrees/my-repo/my-branch")).toBeNull();
    expect(validateSandboxCwd("/workspace/worktrees/repo/feat/deep")).toBeNull();
  });

  it("rejects /workspace/worktrees without trailing slash (not a worktree)", () => {
    expect(validateSandboxCwd("/workspace/worktrees")).not.toBeNull();
  });

  it("rejects /workspace/repos (sandbox-coder requires worktree)", () => {
    expect(validateSandboxCwd("/workspace/repos/my-repo")).not.toBeNull();
  });

  it("rejects relative paths", () => {
    expect(validateSandboxCwd("workspace/worktrees/foo")).not.toBeNull();
  });

  it("rejects empty or missing cwd", () => {
    expect(validateSandboxCwd("")).not.toBeNull();
    expect(validateSandboxCwd(undefined as unknown as string)).not.toBeNull();
  });

  it("rejects traversal attempts", () => {
    expect(validateSandboxCwd("/workspace/worktrees/../repos/escape")).not.toBeNull();
  });
});

describe("validateSandboxCoderArgs", () => {
  it("accepts a prompt (any non-flag args)", () => {
    expect(validateSandboxCoderArgs(["implement", "auth", "fix"])).toBeNull();
    expect(validateSandboxCoderArgs(["fix bug in login"])).toBeNull();
  });

  it("accepts --reconnect with session ID", () => {
    expect(validateSandboxCoderArgs(["--reconnect", "sess-abc-123"])).toBeNull();
  });

  it("rejects --reconnect without session ID", () => {
    expect(validateSandboxCoderArgs(["--reconnect"])).not.toBeNull();
    expect(validateSandboxCoderArgs(["--reconnect", ""])).not.toBeNull();
  });

  it("accepts --pull with sandbox ID", () => {
    expect(validateSandboxCoderArgs(["--pull", "sandbox-xyz"])).toBeNull();
  });

  it("rejects --pull without sandbox ID", () => {
    expect(validateSandboxCoderArgs(["--pull"])).not.toBeNull();
    expect(validateSandboxCoderArgs(["--pull", ""])).not.toBeNull();
  });

  it("rejects empty args", () => {
    expect(validateSandboxCoderArgs([])).not.toBeNull();
  });

  it("rejects non-array", () => {
    expect(validateSandboxCoderArgs("hello" as unknown as string[])).not.toBeNull();
  });
});
