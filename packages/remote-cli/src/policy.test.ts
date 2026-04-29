import { realpathSync } from "node:fs";
import { normalize as normalizePosix } from "node:path/posix";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  resolveGitArgs,
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateLdcliArgs,
  validateLangfuseArgs,
  validateMetabaseArgs,
} from "./policy.js";

beforeEach(() => {
  vi.spyOn(realpathSync, "native").mockImplementation((path) => normalizePosix(String(path)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("rejects paths whose realpath escapes allowed prefixes", () => {
    vi.mocked(realpathSync.native).mockImplementation((path) => {
      if (String(path) === "/workspace/repos/link") return "/tmp/escaped";
      return normalizePosix(String(path));
    });

    expect(validateCwd("/workspace/repos/link")).not.toBeNull();
  });
});

// ── git policy ──────────────────────────────────────────────────────────────

describe("validateGitArgs", () => {
  function expectGitDenied(args: string[], cwd?: string): string {
    const error = validateGitArgs(args, cwd);
    expect(error).toContain("Load skill using-git");
    return error ?? "";
  }

  function expectGitDeniedWith(args: string[], expected: string[], cwd?: string): void {
    const error = expectGitDenied(args, cwd);
    expect(error).toContain("Reason:");
    for (const text of expected) {
      expect(error).toContain(text);
    }
  }

  describe("allowed commands", () => {
    it("allows a representative read command", () => {
      expect(validateGitArgs(["status"])).toBeNull();
    });

    it("allows common git read-only workflows", () => {
      const allowedCommands: string[][] = [
        ["--version"],
        ["status", "--short"],
        ["log", "--oneline", "-5"],
        ["log", "origin/main..HEAD", "--oneline"],
        ["diff", "--stat"],
        ["diff", "origin/main", "--stat"],
        ["diff", "origin/main", "--", "packages/remote-cli/src/policy.ts"],
        ["show", "HEAD~1"],
        ["show", "HEAD", "--stat"],
        ["show", "HEAD:packages/remote-cli/src/policy.ts"],
        ["shortlog", "HEAD~10..HEAD"],
        ["branch", "--show-current"],
        ["branch", "-a"],
        ["branch", "--list"],
        ["branch", "--list", "feat/*"],
        ["branch", "-a", "--list", "feat/*"],
        ["branch", "--list", "--all", "feat/*"],
        ["rev-parse", "--abbrev-ref", "HEAD"],
        ["merge-base", "HEAD", "origin/main"],
        ["fetch", "origin"],
        ["fetch", "origin", "main"],
        ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"],
        ["fetch", "--prune", "origin"],
        ["fetch", "-p", "origin"],
        ["fetch", "origin", "--tags"],
        ["fetch", "--no-tags", "origin", "main"],
        ["fetch", "--depth", "1", "origin", "main"],
        ["fetch", "--all"],
        ["fetch", "--all", "--prune"],
        ["fetch", "--all", "--tags", "--prune"],
        ["ls-files", "--", "packages/remote-cli/src/policy.ts"],
        ["remote"],
        ["remote", "-v"],
        ["remote", "show", "origin"],
        ["remote", "get-url", "origin"],
        ["show-ref", "--verify", "refs/heads/main"],
        ["blame", "packages/remote-cli/src/policy.ts"],
        ["blame", "-L", "10,20", "packages/remote-cli/src/policy.ts"],
        ["reflog"],
        ["reflog", "show", "HEAD"],
        ["grep", "TODO", "--", "packages/remote-cli/src"],
        ["for-each-ref", "--format=%(refname)", "refs/heads/"],
        ["cat-file", "-p", "HEAD"],
        ["cat-file", "--batch-check"],
        ["name-rev", "HEAD"],
        ["describe", "--tags", "--always"],
        ["ls-remote", "origin"],
        ["ls-remote", "--heads", "origin"],
        ["ls-remote", "origin", "refs/heads/main"],
        ["tag"],
        ["tag", "-l"],
        ["tag", "--list", "v*"],
        ["tag", "-n", "--list", "v*"],
        ["tag", "-n5", "--list"],
        ["stash", "list"],
        ["stash", "show", "stash@{0}"],
        ["rev-parse", "HEAD"],
        ["rev-parse", "--short", "HEAD"],
        ["rev-parse", "--show-toplevel"],
        ["rev-parse", "origin/main"],
        ["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"],
        ["rev-parse", "--abbrev-ref", "@{upstream}"],
        ["rev-parse", "HEAD~3"],
        ["rev-parse", "HEAD:packages/remote-cli/src/policy.ts"],
        ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
        ["merge-base", "--fork-point", "origin/main"],
        ["merge-base", "--fork-point", "origin/main", "HEAD"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
    });

    it("allows common git write workflows that stay inside the current repo", () => {
      const allowedCommands: string[][] = [
        ["restore", "--", "package-lock.json"],
        ["restore", "--source", "HEAD~1", "--", "packages/remote-cli/src/policy.ts"],
        ["restore", "--source=origin/main", "--", "Dockerfile"],
        ["restore", "--staged", "--", "packages/remote-cli/src/policy.ts"],
        ["restore", "-S", "--", "packages/remote-cli/src/policy.ts"],
        ["restore", "--staged", "--source", "HEAD~1", "--", "package.json"],
        ["restore", "--source=HEAD", "-S", "--", "README.md"],
        ["add", "docs/plan/2026042406_command-policy-consolidation.md"],
        ["add", "-A"],
        ["add", "packages/remote-cli/src/policy.ts", "packages/remote-cli/src/policy.test.ts"],
        ["commit", "-m", "test: expand git and gh policy coverage"],
        ["commit", "-m", "subject", "-m", "body paragraph"],
        ["commit", "-m", "subject", "-m", "body", "-m", "footer"],
        ["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat"],
        ["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat", "origin/main"],
        ["worktree", "add", "/workspace/worktrees/repo/feat", "-b", "feat"],
        ["worktree", "add", "/workspace/worktrees/repo/feat", "-b", "feat", "origin/main"],
        ["worktree", "add", "/workspace/worktrees/repo/feat", "origin/main", "-b", "feat"],
        // No -b: check out an existing branch into a worktree (PR review flow).
        ["worktree", "add", "/workspace/worktrees/repo/pr-123", "pr-123"],
        ["worktree", "add", "/workspace/worktrees/repo/feat/auth", "feat/auth"],
        ["worktree", "add", "-b", "feat/auth/api", "/workspace/worktrees/repo/feat/auth/api"],
        ["worktree", "add", "/workspace/worktrees/repo/feat/auth/api", "feat/auth/api"],
        [
          "worktree",
          "add",
          "-b",
          "feat/auth/api",
          "/workspace/worktrees/repo/feat/auth/api",
          "origin/main",
        ],
        ["worktree", "list"],
        ["worktree", "list", "--porcelain"],
        ["worktree", "remove", "/workspace/worktrees/repo/feat"],
        ["worktree", "prune"],
        ["worktree", "prune", "--dry-run"],
        ["worktree", "prune", "-n"],
        ["push", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "--dry-run", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "origin", "--dry-run", "HEAD:refs/heads/feat/x"],
        ["push", "origin", "HEAD:refs/heads/feat/x", "--dry-run"],
        ["push", "-u", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "origin", "-u", "HEAD:refs/heads/feat/x"],
        ["push", "--set-upstream", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "origin", "HEAD:refs/heads/feat/x", "--set-upstream"],
        ["merge", "origin/main"],
        ["merge", "feat/sibling"],
        ["merge", "abc1234"],
        ["merge", "FETCH_HEAD"],
        ["merge", "--ff-only", "origin/main"],
        ["merge", "--no-ff", "--no-edit", "origin/main"],
        ["merge", "--squash", "feat/sibling"],
        ["merge", "-X", "ours", "origin/main"],
        ["merge", "--strategy=ours", "origin/main"],
        ["merge", "-m", "merge origin/main", "origin/main"],
        ["merge", "--allow-unrelated-histories", "origin/main"],
        ["merge", "origin/feat-a", "origin/feat-b"],
        ["merge"],
        ["merge", "--abort"],
        ["merge", "--continue"],
        ["merge", "--quit"],
        ["revert", "HEAD~1"],
        ["revert", "--no-edit", "abc1234"],
        ["revert", "--no-commit", "HEAD~3..HEAD"],
        ["revert", "-m", "1", "abc1234"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
    });

    it("allows git commit -F with a body file path", () => {
      expect(validateGitArgs(["commit", "-F", "msg.txt"])).toBeNull();
      expect(validateGitArgs(["commit", "--file", "docs/msg.md"])).toBeNull();
      expect(validateGitArgs(["commit", "-F", "/tmp/msg.txt"])).toBeNull();
      expect(validateGitArgs(["commit", "--file=msg.txt"])).toBeNull();
    });

    it("returns explicit push args unchanged", () => {
      expect(resolveGitArgs(["push", "origin", "HEAD:refs/heads/feat/test"])).toEqual({
        args: ["push", "origin", "HEAD:refs/heads/feat/test"],
      });
      expect(resolveGitArgs(["push", "--dry-run", "origin", "HEAD:refs/heads/feat/test"])).toEqual({
        args: ["push", "--dry-run", "origin", "HEAD:refs/heads/feat/test"],
      });
    });
  });

  describe("blocked commands", () => {
    it("blocks git clone", () => {
      expectGitDenied(["clone", "https://github.com/foo/bar"]);
    });

    it("blocks git init", () => {
      expectGitDenied(["init"]);
    });

    it("blocks leading git flags before the subcommand", () => {
      expectGitDenied(["-C", "/tmp", "status"]);
      expectGitDenied(["-c", "credential.helper=!evil", "push", "origin"]);
      expectGitDenied(["--exec-path=/tmp/evil", "status"]);
    });

    it("blocks checkout and switch", () => {
      expectGitDenied(["checkout", "main"]);
      expectGitDenied(["switch", "feature"]);
      expectGitDenied(["checkout", "-b", "feat/test", "origin/main"]);
    });

    it("returns actionable denial guidance for common blocked git workflows", () => {
      expectGitDeniedWith(
        ["checkout", "main"],
        [
          "checkout can switch branches",
          "git worktree add /workspace/worktrees/<repo>/<branch> <branch>",
        ],
      );
      expectGitDeniedWith(
        ["switch", "feature"],
        [
          "switch changes the current worktree branch",
          "git worktree add /workspace/worktrees/<repo>/<branch> <branch>",
        ],
      );
      expectGitDeniedWith(
        ["pull", "origin", "feat/x"],
        [
          "pull depends on local upstream/config",
          "git fetch origin <branch> && git merge origin/<branch>",
        ],
      );
      expectGitDeniedWith(
        ["push", "origin", "feat/x"],
        ["explicit HEAD refspec", "git push origin HEAD:refs/heads/<branch>"],
      );
      expectGitDeniedWith(
        ["restore", "package.json"],
        ["paths after a -- separator", "git restore [--source <tree>] [--staged] -- <path>"],
      );
      expectGitDeniedWith(
        ["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/other"],
        [
          "end with the branch name",
          "git worktree add /workspace/worktrees/<repo>/<branch> <branch>",
        ],
      );
    });

    it("blocks worktree add outside /workspace/worktrees/", () => {
      expectGitDenied(["worktree", "add", "-b", "feat", "/tmp/evil"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/repos/sneaky"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/../repos/escape"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "workspace/worktrees/repo/feat"]);
    });

    it("blocks worktree add when path branch does not equal branch arg", () => {
      // -b form: branch is "feat", path branch is "other"
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/other"]);
      // No-b form: branch is "pr-123", path branch is "review"
      expectGitDenied(["worktree", "add", "/workspace/worktrees/repo/review", "pr-123"]);
      // Slashy branch with mismatched branch path
      expectGitDenied(["worktree", "add", "-b", "feat/auth", "/workspace/worktrees/repo/auth"]);
      // Branch is "a", path branch is "aa" (substring mismatch)
      expectGitDenied(["worktree", "add", "/workspace/worktrees/repo/aa", "a"]);
      // Branch must match the full path under /workspace/worktrees/<repo>/
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat/sub"]);
    });

    it("blocks invalid worktree add branch/path values", () => {
      expectGitDenied(["worktree", "add", "-b", "", "/workspace/worktrees/repo/feat"]);
      expectGitDenied(["worktree", "add", "-b", "/feat", "/workspace/worktrees/repo/feat"]);
      expectGitDenied(["worktree", "add", "-b", "feat/", "/workspace/worktrees/repo/feat/"]);
      expectGitDenied(["worktree", "add", "-b", "feat//x", "/workspace/worktrees/repo/feat//x"]);
      expectGitDenied([
        "worktree",
        "add",
        "-b",
        "feat/../x",
        "/workspace/worktrees/repo/feat/../x",
      ]);
      expectGitDenied([
        "worktree",
        "add",
        "-b",
        "feat\u0000x",
        "/workspace/worktrees/repo/feat\u0000x",
      ]);

      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees//feat"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo//feat"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/../feat"]);
    });

    it("blocks malformed worktree add shapes", () => {
      // No -b and only one positional
      expectGitDenied(["worktree", "add", "/workspace/worktrees/repo/feat"]);
      // No -b and three positionals
      expectGitDenied(["worktree", "add", "/workspace/worktrees/repo/feat", "feat", "extra"]);
      // Two -b flags
      expectGitDenied(["worktree", "add", "-b", "a", "-b", "b", "/workspace/worktrees/repo/b"]);
    });

    it("blocks worktree remove outside /workspace/worktrees/ and unsupported forms", () => {
      expectGitDenied(["worktree", "remove", "/tmp/evil"]);
      expectGitDenied(["worktree", "remove", "/workspace/repos/sneaky"]);
      expectGitDenied(["worktree", "remove", "/workspace/worktrees/../etc"]);
      expectGitDenied(["worktree", "remove", "workspace/worktrees/repo/feat"]);
      expectGitDenied(["worktree", "remove", "--force", "/workspace/worktrees/repo/feat"]);
      expectGitDenied(["worktree", "remove"]);
    });

    it("blocks worktree remove when realpath escapes /workspace/worktrees/", () => {
      vi.mocked(realpathSync.native).mockImplementation((path) => {
        if (String(path) === "/workspace/worktrees/repo/link") return "/tmp/escaped";
        return normalizePosix(String(path));
      });

      expectGitDenied(["worktree", "remove", "/workspace/worktrees/repo/link"]);
    });

    it("blocks unsupported worktree subcommands and flag shapes", () => {
      expectGitDenied(["worktree"]);
      expectGitDenied(["worktree", "move", "/a", "/b"]);
      expectGitDenied(["worktree", "lock", "/workspace/worktrees/repo/feat"]);
      expectGitDenied(["worktree", "list", "--verbose"]);
      expectGitDenied(["worktree", "prune", "--expire", "1.day.ago"]);
    });

    it("allows worktree paths with nested branch names", () => {
      expect(
        validateGitArgs([
          "worktree",
          "add",
          "-b",
          "feat/my-feature",
          "/workspace/worktrees/repo/feat/my-feature",
        ]),
      ).toBeNull();
    });

    it("blocks branch commands outside the approved read-only shapes", () => {
      expectGitDenied(["branch", "-m", "rename-policy-tests"]);
      expectGitDenied(["branch", "feat/test"]);
      expectGitDenied(["branch", "--list", "feat/*", "fix/*"]);
      expectGitDenied(["branch", "-a", "feat/*"]);
      expectGitDenied(["branch", "--show-current", "--list"]);
    });

    it("blocks merge-base shapes outside the allowed forms", () => {
      expectGitDenied(["merge-base"]);
      expectGitDenied(["merge-base", "HEAD"]);
      expectGitDenied(["merge-base", "--octopus", "HEAD", "origin/main"]);
      expectGitDenied(["merge-base", "--is-ancestor", "--all", "HEAD", "origin/main"]);
      expectGitDenied(["merge-base", "--fork-point", "--all", "origin/main"]);
    });

    it("blocks ls-remote to remotes other than origin", () => {
      expectGitDenied(["ls-remote"]);
      expectGitDenied(["ls-remote", "upstream"]);
      expectGitDenied(["ls-remote", "https://evil.com/repo.git"]);
      expectGitDenied(["ls-remote", "--heads"]);
    });

    it("blocks tag creation, deletion, and other write forms", () => {
      expectGitDenied(["tag", "v1.0.0"]);
      expectGitDenied(["tag", "-a", "v1.0.0", "-m", "release"]);
      expectGitDenied(["tag", "-d", "v1.0.0"]);
      expectGitDenied(["tag", "-f", "v1.0.0"]);
      expectGitDenied(["tag", "-s", "v1.0.0"]);
      expectGitDenied(["tag", "--delete", "v1.0.0"]);
      expectGitDenied(["tag", "--contains", "HEAD"]);
    });

    it("blocks stash write subcommands", () => {
      expectGitDenied(["stash"]);
      expectGitDenied(["stash", "push"]);
      expectGitDenied(["stash", "pop"]);
      expectGitDenied(["stash", "apply"]);
      expectGitDenied(["stash", "drop"]);
      expectGitDenied(["stash", "clear"]);
      expectGitDenied(["stash", "save", "wip"]);
      expectGitDenied(["stash", "branch", "recovery"]);
    });

    it("blocks git remote add/set-url/rename/remove and other unsupported shapes", () => {
      expectGitDenied(["remote", "add", "evil", "https://evil.com/repo.git"]);
      expectGitDenied(["remote", "set-url", "origin", "https://evil.com/repo.git"]);
      expectGitDenied(["remote", "rename", "origin", "old"]);
      expectGitDenied(["remote", "remove", "origin"]);
      expectGitDenied(["remote", "prune", "origin"]);
    });

    it("blocks fetches outside the allowlist", () => {
      expectGitDenied(["fetch"]);
      expectGitDenied(["fetch", "upstream"]);
      expectGitDenied(["fetch", "upstream", "--prune"]);
      expectGitDenied(["fetch", "--all", "origin"]);
      expectGitDenied(["fetch", "origin", "--tags", "--no-tags"]);
      expectGitDenied(["fetch", "--depth"]);
      expectGitDenied(["fetch", "--depth", "abc", "origin"]);
      expectGitDenied(["fetch", "--depth", "0", "origin"]);
      expectGitDenied(["fetch", "--depth", "1", "--depth", "2", "origin"]);
      expectGitDenied(["fetch", "--unshallow", "origin"]);
      expectGitDenied(["fetch", "--receive-pack=evil", "origin"]);
    });

    it("blocks push to non-origin remotes", () => {
      expectGitDenied(["push", "evil", "HEAD:refs/heads/feat/x"]);
      expectGitDenied(["push", "https://evil.com/repo.git", "HEAD:refs/heads/feat/x"]);
      expectGitDenied(["push", "upstream", "HEAD:refs/heads/feat/x"]);
    });

    it("blocks security-sensitive push flags", () => {
      expectGitDenied(["push", "--receive-pack=evil", "origin", "HEAD:refs/heads/feat/x"]);
      expectGitDenied(["push", "--repo=https://evil.com", "origin", "HEAD:refs/heads/feat/x"]);
      expectGitDenied(["push", "--exec=evil", "origin", "HEAD:refs/heads/feat/x"]);
    });

    it("rejects unknown push flags but keeps known safe ones working", () => {
      expectGitDenied(["push", "--some-unknown-flag", "origin", "HEAD:refs/heads/feat/x"]);
      expect(validateGitArgs(["push", "--dry-run", "origin", "HEAD:refs/heads/feat/x"])).toBeNull();
      expect(validateGitArgs(["push", "-u", "origin", "HEAD:refs/heads/feat/x"])).toBeNull();
      expect(
        validateGitArgs(["push", "--set-upstream", "origin", "HEAD:refs/heads/feat/x"]),
      ).toBeNull();
    });

    it("requires an explicit HEAD refspec push shape", () => {
      expectGitDenied(["push"]);
      expectGitDenied(["push", "origin"]);
      expectGitDenied(["push", "HEAD"]);
      expectGitDenied(["push", "origin", "feat/x"]);
    });

    it("allows -u / --set-upstream to set upstream tracking", () => {
      expect(validateGitArgs(["push", "-u", "origin", "HEAD:refs/heads/feat/x"])).toBeNull();
      expect(
        validateGitArgs(["push", "--set-upstream", "origin", "HEAD:refs/heads/feat/x"]),
      ).toBeNull();
    });

    it("blocks pushes to protected target branches", () => {
      expectGitDenied(["push", "origin", "main"]);
      expectGitDenied(["push", "origin", "master"]);
      expectGitDenied(["push", "origin", "HEAD:refs/heads/main"]);
      expectGitDenied(["push", "origin", "HEAD:refs/heads/master"]);
    });

    it("allows explicit HEAD refspecs and blocks dangerous mapped refspecs", () => {
      expect(validateGitArgs(["push", "origin", "HEAD:refs/heads/feat/auth"])).toBeNull();
      expectGitDenied(["push", "origin", "+HEAD:refs/heads/main"]);
      expectGitDenied(["push", "origin", "main:refs/heads/other"]);
      expectGitDenied(["push", "origin", "HEAD:refs/tags/v1"]);
      expectGitDenied(["push", "origin", ":main"]);
      expectGitDenied(["push", "origin", "HEAD:refs/heads/foo:bar"]);
    });

    it("blocks merge --no-verify (hook bypass)", () => {
      expectGitDenied(["merge", "--no-verify", "origin/main"]);
      expectGitDenied(["merge", "origin/main", "--no-verify"]);
      expectGitDenied(["merge", "--no-ff", "--no-verify", "origin/main"]);
    });

    it("blocks malformed commit forms", () => {
      // Interactive / unsafe shapes
      expectGitDenied(["commit"]);
      expectGitDenied(["commit", "-m"]);
      expectGitDenied(["commit", "-m", "x", "--amend"]);
      expectGitDenied(["commit", "-m", "x", "--no-verify"]);
      expectGitDenied(["commit", "-a", "-m", "x"]);
      expectGitDenied(["commit", "-s", "-m", "x"]);
      expectGitDenied(["commit", "-m", "x", "--signoff"]);
      expectGitDenied(["commit", "--allow-empty", "-m", "x"]);
      expectGitDenied(["commit", "some-path"]);
      // Mutually exclusive body sources
      expectGitDenied(["commit", "-m", "x", "-F", "msg.txt"]);
      // Duplicate -F
      expectGitDenied(["commit", "-F", "a.md", "--file", "b.md"]);
    });

    it("blocks malformed restore forms", () => {
      expectGitDenied(["restore"]);
      expectGitDenied(["restore", "--"]);
      expectGitDenied(["restore", "package.json"]);
      expectGitDenied(["restore", "--source"]);
      expectGitDenied(["restore", "--source=", "--", "package.json"]);
      expectGitDenied(["restore", "--source", "HEAD", "--source", "origin/main", "--", "a"]);
      expectGitDenied(["restore", "--source=HEAD", "--source=origin/main", "--", "a"]);
      expectGitDenied(["restore", "--worktree", "--", "a"]);
      expectGitDenied(["restore", "--overlay", "--", "a"]);
      expectGitDenied(["restore", "--staged", "package.json"]);
    });

    it("blocks commands removed from the allowlist", () => {
      expectGitDenied(["config", "--global", "--get", "user.name"]);
      expectGitDenied(["config", "user.name", "Thor"]);
      expectGitDenied(["--no-pager", "log", "--oneline", "-10"]);
      expectGitDenied(["check-ignore", "--stdin"]);
      expectGitDenied(["symbolic-ref", "HEAD", "refs/heads/main"]);
      expectGitDenied(["pull", "origin", "feat/x"]);
    });

    it("blocks arbitrary commands", () => {
      expectGitDenied(["fsck"]);
      expectGitDenied(["gc"]);
      expectGitDenied(["daemon"]);
    });
  });

  it("rejects empty args", () => {
    expect(validateGitArgs([])).not.toBeNull();
  });

  it("rejects non-array", () => {
    expect(validateGitArgs("status" as unknown as string[])).not.toBeNull();
  });

  it("rejects leading flags that are not explicitly allowlisted", () => {
    expectGitDenied(["--exec-path=/tmp/evil"]);
  });
});

// ── gh policy ───────────────────────────────────────────────────────────────

describe("validateGhArgs", () => {
  function expectGhDenied(args: string[], cwd?: string): string {
    const error = validateGhArgs(args, cwd);
    expect(error).toContain("Load skill using-gh");
    return error ?? "";
  }

  function expectGhDeniedWith(args: string[], expected: string[], cwd?: string): void {
    const error = expectGhDenied(args, cwd);
    expect(error).toContain("Reason:");
    for (const text of expected) {
      expect(error).toContain(text);
    }
  }

  const HEAD_CWD = "/workspace/worktrees/myrepo/feat/test";

  describe("allowed commands", () => {
    it("allows common gh read-only workflows", () => {
      const allowedCommands: string[][] = [
        [],
        ["--version"],
        ["--help"],
        ["auth", "status"],
        ["pr", "view"],
        ["pr", "view", "123"],
        ["pr", "view", "https://github.com/acme/web/pull/123"],
        ["pr", "view", "123", "--json", "title", "--jq", ".title"],
        ["pr", "list", "--limit", "10"],
        ["pr", "list", "--search", "is:open", "--limit", "10"],
        ["pr", "status"],
        ["pr", "checks", "123", "--watch"],
        ["issue", "view", "42"],
        ["issue", "view", "42", "--json", "title", "--jq", ".title"],
        ["issue", "list", "--limit", "10"],
        ["search", "prs", "is:open reviewer:me"],
        ["search", "issues", "label:bug sort:updated-desc"],
        ["search", "repos", "org:acme topic:observability"],
        ["search", "code", "sandbox"],
        ["label", "list", "--limit", "20"],
        ["release", "list", "--limit", "5"],
        ["release", "view", "latest"],
        ["release", "view", "v1.2.3", "--json", "tagName"],
        ["cache", "list", "--limit", "20"],
        ["repo", "view"],
        ["repo", "view", "owner/repo", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        ["run", "list", "--limit", "10"],
        ["run", "view", "123", "--log"],
        ["run", "watch", "123", "--exit-status"],
        ["workflow", "list", "--all"],
        ["workflow", "view", "ci.yml", "--yaml"],
      ];

      for (const args of allowedCommands) {
        expect(validateGhArgs(args)).toBeNull();
      }
    });

    it("allows gh help and command introspection flows", () => {
      const allowedCommands: string[][] = [
        ["help"],
        ["help", "formatting"],
        ["help", "environment"],
        ["help", "api"],
        ["pr", "--help"],
        ["pr", "view", "--help"],
        ["pr", "create", "--help"],
        ["pr", "comment", "--help"],
        ["pr", "review", "--help"],
        ["issue", "--help"],
        ["issue", "comment", "--help"],
        ["run", "--help"],
        ["workflow", "--help"],
        ["repo", "--help"],
        ["api", "--help"],
      ];

      for (const args of allowedCommands) {
        expect(validateGhArgs(args)).toBeNull();
      }
    });

    it("allows append-only pr create with explicit title/body", () => {
      expect(
        validateGhArgs(["pr", "create", "--title", "Add feature", "--body", "Summary"]),
      ).toBeNull();
      expect(
        validateGhArgs(["pr", "create", "-t", "Add feature", "-b", "Summary", "--draft"]),
      ).toBeNull();
      expect(
        validateGhArgs([
          "pr",
          "create",
          "--base",
          "main",
          "--title",
          "Add feature",
          "--body",
          "Summary",
        ]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "create", "--title=Add feature", "--body=Summary"])).toBeNull();
    });

    it("allows pr create with --fill and creation-time metadata", () => {
      expect(validateGhArgs(["pr", "create", "--fill"])).toBeNull();
      expect(validateGhArgs(["pr", "create", "--fill", "--draft"])).toBeNull();
      expect(
        validateGhArgs([
          "pr",
          "create",
          "--title",
          "x",
          "--body",
          "y",
          "--label",
          "bug",
          "--label",
          "p1",
          "--assignee",
          "alice",
          "--reviewer",
          "bob",
          "--reviewer",
          "carol",
        ]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "create", "--title", "x", "-F", "body.md"])).toBeNull();
      expect(
        validateGhArgs(["pr", "create", "--title", "x", "--body-file", "docs/pr-body.md"]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "create", "--title", "x", "-F", "/tmp/body.md"])).toBeNull();
    });

    it("allows gh run rerun / run download / workflow run within policy", () => {
      expect(validateGhArgs(["run", "rerun", "123"])).toBeNull();
      expect(validateGhArgs(["run", "rerun", "123", "--failed"])).toBeNull();
      expect(validateGhArgs(["run", "rerun", "123", "--failed", "--debug"])).toBeNull();
      expect(validateGhArgs(["run", "download", "123"])).toBeNull();
      expect(validateGhArgs(["run", "download", "123", "--dir", "artifacts"])).toBeNull();
      expect(validateGhArgs(["run", "download", "123", "--dir", "/tmp/artifacts"])).toBeNull();
      expect(
        validateGhArgs(["run", "download", "123", "--name", "logs", "--name", "coverage"]),
      ).toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml"])).toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml", "--ref", "main"])).toBeNull();
      expect(
        validateGhArgs([
          "workflow",
          "run",
          "ci.yml",
          "--ref",
          "main",
          "-f",
          "env=staging",
          "-f",
          "dry_run=true",
        ]),
      ).toBeNull();
      // Typed -F values (number, boolean) and the @file form pass through.
      expect(validateGhArgs(["workflow", "run", "ci.yml", "-F", "count=5"])).toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml", "-F", "enabled=true"])).toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml", "-F", "payload=@input.json"])).toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml", "--field", "retries=null"])).toBeNull();
    });

    it("allows append-only issue create with title/body and optional labels", () => {
      expect(validateGhArgs(["issue", "create", "--title", "Bug", "--body", "Broken"])).toBeNull();
      expect(
        validateGhArgs([
          "issue",
          "create",
          "--title",
          "Bug",
          "--body",
          "Broken",
          "--label",
          "bug",
          "--label",
          "p1",
        ]),
      ).toBeNull();
    });

    it("allows append-only pr/issue comments with explicit body", () => {
      expect(validateGhArgs(["pr", "comment", "123", "--body", "noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "-b", "noted"])).toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--body=noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "-F", "comment.md"])).toBeNull();
    });

    it("allows append-only pr reviews for comment/request-changes", () => {
      expect(validateGhArgs(["pr", "review", "--comment", "--body", "LGTM-ish"])).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "--comment", "--body", "LGTM-ish"])).toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--request-changes", "--body", "needs tests"]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "-c", "-b", "review body"])).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "-r", "--body=review body"])).toBeNull();
    });

    it("allows implicit-get gh api reads with output shaping only", () => {
      expect(validateGhArgs(["api", "repos/{owner}/{repo}"])).toBeNull();
      expect(
        validateGhArgs(["api", "repos/{owner}/{repo}/pulls", "--jq", ".[].number"]),
      ).toBeNull();
      expect(validateGhArgs(["api", "repos/{owner}/{repo}", "--template", "{{.name}}"])).toBeNull();
      expect(validateGhArgs(["api", "repos/{owner}/{repo}", "--include", "--silent"])).toBeNull();
      expect(
        validateGhArgs(["api", "repos/{owner}/{repo}/pulls", "--paginate", "--jq", ".[].number"]),
      ).toBeNull();
    });

    it("allows append-only gh api replies to current-repo PR review comments", () => {
      expect(
        validateGhArgs([
          "api",
          "repos/{owner}/{repo}/pulls/53/comments/123/replies",
          "--method",
          "POST",
          "-f",
          "body=Thanks, I fixed this.",
        ]),
      ).toBeNull();
      expect(
        validateGhArgs([
          "api",
          "/repos/{owner}/{repo}/pulls/53/comments/123/replies",
          "--method=POST",
          "--raw-field=body=Thanks, I fixed this.",
        ]),
      ).toBeNull();
      expect(
        validateGhArgs([
          "api",
          "repos/{owner}/{repo}/pulls/53/comments/123/replies",
          "-X",
          "POST",
          "--raw-field",
          "body=Done.",
        ]),
      ).toBeNull();
    });

    it("does not route body values that look like help flags into the help path", () => {
      expect(validateGhArgs(["pr", "comment", "123", "--body", "-h"])).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "--comment", "--body", "--help"])).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks non-append-only pr state mutation commands", () => {
      expectGhDenied(["pr", "edit", "123", "--title", "new"]);
      expectGhDenied(["pr", "ready", "123"]);
    });

    it("blocks pr merge", () => {
      expectGhDenied(["pr", "merge", "123"]);
    });

    it("blocks run/workflow mutation commands outside the allowlist", () => {
      expectGhDenied(["run", "cancel", "123"]);
      expectGhDenied(["run", "delete", "123"]);
      expectGhDenied(["workflow", "enable", "ci.yml"]);
      expectGhDenied(["workflow", "disable", "ci.yml"]);
    });

    it("blocks repo create", () => {
      expectGhDenied(["repo", "create", "foo"]);
    });

    it("blocks repo delete", () => {
      expectGhDenied(["repo", "delete", "foo"]);
    });

    it("blocks auth commands", () => {
      expectGhDenied(["auth", "login"]);
    });

    it("blocks secret commands", () => {
      expectGhDenied(["secret", "set", "FOO"]);
    });

    it("blocks gh pr diff and gh pr checkout to force worktree-based review", () => {
      expectGhDenied(["pr", "diff", "2984"]);
      expectGhDenied(["pr", "diff", "2984", "--patch"]);
      expectGhDenied(["pr", "checkout", "2984"]);
    });

    it("returns actionable denial guidance for common blocked gh workflows", () => {
      expectGhDeniedWith(
        ["pr", "checkout", "2984"],
        ["would switch the current worktree branch", "git fetch origin pull/<N>/head:pr-<N>"],
      );
      expectGhDeniedWith(
        ["pr", "diff", "2984"],
        [
          "PR review should happen from a fetched worktree",
          "git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>",
        ],
      );
      expectGhDeniedWith(
        ["pr", "view", "123", "--repo", "owner/repo"],
        ["repo-targeting flags are blocked", "cd into the intended repo or worktree"],
      );
      expectGhDeniedWith(
        ["pr", "create", "--head", "feat/other", "--title", "x", "--body", "y"],
        [
          '--head "feat/other" does not match cwd branch "feat/test".',
          "cd into /workspace/worktrees/<repo>/feat/other or omit --head",
        ],
        HEAD_CWD,
      );
      expectGhDeniedWith(
        ["api", "repos/org/repo", "--method", "GET"],
        ["implicit GET reads", "gh api <endpoint> --jq <filter>"],
      );
      expectGhDeniedWith(
        ["pr", "comment", "123"],
        ["numeric PR", "gh pr comment <number> --body <text>"],
      );
    });

    it("blocks repo-targeting flags across the gh surface", () => {
      expectGhDenied(["pr", "view", "123", "--repo", "owner/repo"]);
      expectGhDenied(["issue", "view", "42", "-R", "owner/repo"]);
      expectGhDenied(["issue", "view", "42", "-Rowner/repo"]);
      expectGhDenied(["pr", "view", "123", "-Rowner/repo"]);
      expectGhDenied(["repo", "view", "--repo=owner/repo"]);
      expectGhDenied(["pr", "create", "--repo", "org/repo", "--title", "x", "--body", "y"]);
    });

    it("blocks removed pr create forms", () => {
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--web"]);
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--editor"]);
    });

    it("allows --head only when it matches the branch implied by cwd", () => {
      expect(
        validateGhArgs(
          ["pr", "create", "--head", "feat/test", "--title", "x", "--body", "y"],
          HEAD_CWD,
        ),
      ).toBeNull();
      expect(
        validateGhArgs(
          ["pr", "create", "-H", "feat/test", "--title", "x", "--body", "y"],
          HEAD_CWD,
        ),
      ).toBeNull();
      expect(
        validateGhArgs(
          ["pr", "create", "--head=feat/test", "--title", "x", "--body", "y"],
          HEAD_CWD,
        ),
      ).toBeNull();
      expect(
        validateGhArgs(["pr", "create", "--fill", "--head", "feat/test"], HEAD_CWD),
      ).toBeNull();
    });

    it("blocks --head when it does not match cwd's branch", () => {
      // Different branch in the same repo
      expectGhDeniedWith(
        ["pr", "create", "--head", "feat/other", "--title", "x", "--body", "y"],
        [
          '--head "feat/other" does not match cwd branch "feat/test".',
          "cd into /workspace/worktrees/<repo>/feat/other or omit --head",
        ],
        HEAD_CWD,
      );
      // Cross-fork form: monalisa:feat/test cannot match cwd's branch (feat/test)
      expectGhDeniedWith(
        ["pr", "create", "--head", "monalisa:feat/test", "--title", "x", "--body", "y"],
        ['--head "monalisa:feat/test" uses a cross-fork selector', "omit --head"],
        HEAD_CWD,
      );
      // Protected branches deny early even if cwd were to claim them
      expectGhDeniedWith(
        ["pr", "create", "--head", "main", "--title", "x", "--body", "y"],
        ['--head "main" targets a protected branch.', "feature worktree branch"],
        "/workspace/worktrees/myrepo/main",
      );
      expectGhDeniedWith(
        ["pr", "create", "--head", "master", "--title", "x", "--body", "y"],
        ['--head "master" targets a protected branch.', "feature worktree branch"],
        "/workspace/worktrees/myrepo/master",
      );
      // Repeated --head is ambiguous regardless of values
      expectGhDeniedWith(
        [
          "pr",
          "create",
          "--head",
          "feat/test",
          "--head",
          "feat/test",
          "--title",
          "x",
          "--body",
          "y",
        ],
        ["multiple --head values are ambiguous.", "provide at most one --head value"],
        HEAD_CWD,
      );
      // Argument-injection-shaped values are rejected before the cwd check
      expectGhDeniedWith(
        ["pr", "create", "--head", "-rm", "--title", "x", "--body", "y"],
        ['--head "-rm" is not a valid branch value.', "omit --head"],
        HEAD_CWD,
      );
    });

    it("blocks --head when cwd is outside /workspace/worktrees/", () => {
      expectGhDeniedWith(
        ["pr", "create", "--head", "feat/test", "--title", "x", "--body", "y"],
        ['--head "feat/test" cannot be checked because cwd is not a branch worktree.'],
        "/workspace/repos/myrepo",
      );
      expectGhDeniedWith(
        ["pr", "create", "--head", "feat/test", "--title", "x", "--body", "y"],
        ['--head "feat/test" cannot be checked because cwd is not a branch worktree.'],
        undefined,
      );
      // cwd at the worktrees root with no branch segment
      expectGhDeniedWith(
        ["pr", "create", "--head", "feat/test", "--title", "x", "--body", "y"],
        ['--head "feat/test" cannot be checked because cwd is not a branch worktree.'],
        "/workspace/worktrees/myrepo",
      );
    });

    it("blocks conflicting pr create body sources", () => {
      // --fill is exclusive with --title/--body/-F
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--fill"]);
      expectGhDenied(["pr", "create", "--fill", "--title", "x"]);
      expectGhDenied(["pr", "create", "--fill", "-F", "body.md"]);
      // --body and -F are mutually exclusive
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "-F", "body.md"]);
      // Title still required when -F supplies body
      expectGhDenied(["pr", "create", "-F", "body.md"]);
      // Duplicate -F
      expectGhDenied(["pr", "create", "--title", "x", "-F", "a.md", "--body-file", "b.md"]);
    });

    it("blocks pr comment double-source and issue comment -F entirely", () => {
      // pr comment: -F and --body cannot be combined
      expectGhDenied(["pr", "comment", "123", "--body", "x", "-F", "body.md"]);
      // issue comment does not support -F
      expectGhDenied(["issue", "comment", "42", "-F", "body.md"]);
    });

    it("blocks unsafe run rerun / run download / workflow run shapes", () => {
      // Non-numeric selectors
      expectGhDenied(["run", "rerun"]);
      expectGhDenied(["run", "rerun", "abc"]);
      expectGhDenied(["run", "download", "abc"]);
      // Unsupported rerun flags
      expectGhDenied(["run", "rerun", "123", "--job", "456"]);
      // Duplicate --dir
      expectGhDenied(["run", "download", "123", "--dir", "a", "--dir", "b"]);
      // Workflow run: missing selector / flag selector / duplicate --ref
      expectGhDenied(["workflow", "run"]);
      expectGhDenied(["workflow", "run", "--ref", "main"]);
      expectGhDenied(["workflow", "run", "ci.yml", "--ref", "main", "--ref", "dev"]);
    });

    it("blocks issue create without title or body and with unsupported flags", () => {
      expectGhDenied(["issue", "create"]);
      expectGhDenied(["issue", "create", "--title", "x"]);
      expectGhDenied(["issue", "create", "--body", "y"]);
      expectGhDenied(["issue", "create", "--title", "x", "--body", "y", "--assignee", "alice"]);
      expectGhDenied(["issue", "create", "--title", "x", "--body-file", "body.md"]);
      expectGhDenied(["issue", "create", "--title", "x", "--body", "y", "--repo", "org/repo"]);
    });

    it("requires pr create to include --title and --body", () => {
      expectGhDenied(["pr", "create", "--title", "x"]);
      expectGhDenied(["pr", "create", "--body", "y"]);
      expectGhDenied(["pr", "create", "--title"]);
      expectGhDenied(["pr", "create", "--body"]);
    });

    it("blocks non-numeric or malformed comment selectors", () => {
      expectGhDenied(["pr", "comment", "feat/test", "--body", "x"]);
      expectGhDenied(["issue", "comment", "abc", "--body", "x"]);
      expectGhDenied(["pr", "comment", "123", "124", "--body", "x"]);
    });

    it("requires comments to provide a body", () => {
      expectGhDenied(["pr", "comment", "123"]);
      expectGhDenied(["pr", "comment", "123", "--body"]);
      expectGhDenied(["issue", "comment", "42"]);
    });

    it("blocks non-numeric or malformed pr review selectors", () => {
      expectGhDenied(["pr", "review", "feat/test", "--comment", "--body", "x"]);
      expectGhDenied(["pr", "review", "owner/repo#123", "--comment", "--body", "x"]);
      expectGhDenied(["pr", "review", "123", "124", "--comment", "--body", "x"]);
    });

    it("blocks pr review approve and unknown shapes", () => {
      expectGhDenied(["pr", "review", "123", "--approve", "--body", "ok"]);
      expectGhDenied(["pr", "review", "123", "-a", "-b", "ok"]);
      expectGhDenied(["pr", "review", "123", "--comment", "--web", "--body", "ok"]);
      expectGhDenied(["pr", "review", "123", "--request-changes", "--editor", "--body", "x"]);
      expectGhDenied(["pr", "review", "123", "--comment", "--body-file", "review.md"]);
      expectGhDenied(["pr", "review", "123", "--comment", "--foo", "x", "--body", "ok"]);
    });

    it("requires pr review mode and body", () => {
      expectGhDenied(["pr", "review", "123", "--body", "x"]);
      expectGhDenied(["pr", "review", "123", "--comment"]);
      expectGhDenied(["pr", "review", "123", "--comment", "--request-changes", "--body", "x"]);
    });

    it("requires required selectors for exact read commands", () => {
      expectGhDenied(["issue", "view"]);
      expectGhDenied(["issue", "view", "abc"]);
      expectGhDenied(["run", "view"]);
      expectGhDenied(["run", "view", "abc"]);
      expectGhDenied(["run", "watch"]);
      expectGhDenied(["workflow", "view"]);
    });

    it("blocks still-unsupported search, release, and cache command shapes", () => {
      expectGhDenied(["search", "commits", "hash:abc"]);
      expectGhDenied(["release", "download", "v1.2.3"]);
      expectGhDenied(["release", "delete", "v1.2.3"]);
      expectGhDenied(["release", "view"]);
      expectGhDenied(["release", "create", "v1.2.3"]);
      expectGhDenied(["cache", "delete", "123"]);
      expectGhDenied(["label", "create", "bug"]);
      expectGhDenied(["label", "delete", "bug"]);
    });
  });

  describe("gh api", () => {
    it("blocks unsafe gh api execution forms", () => {
      expectGhDenied(["api", "graphql"]);
      expectGhDenied(["api", "-X", "GET", "repos/org/repo"]);
      expectGhDenied(["api", "repos/org/repo", "--method", "GET"]);
      expectGhDenied(["api", "repos/org/repo", "--method", "POST"]);
      expectGhDenied(["api", "repos/org/repo", "--input", "body.json"]);
      expectGhDenied(["api", "repos/org/repo", "-H", "Accept: application/json"]);
      expectGhDenied(["api", "repos/org/repo", "--preview", "corsair"]);
      expectGhDenied(["api", "repos/org/repo", "--hostname", "ghe.example.com"]);
      expectGhDenied(["api", "repos/org/repo", "-f", "state=open"]);
      expectGhDenied(["api", "repos/org/repo", "-F", "q=@query.graphql"]);
      expectGhDenied(["api", "--silent", "repos/org/repo"]);
    });

    it("blocks unsafe gh api review-comment reply shapes", () => {
      expectGhDenied([
        "api",
        "repos/acme/web/pulls/53/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
      ]);
      expectGhDenied(["api", "repos/{owner}/{repo}/pulls/53/comments/123", "--method", "PATCH"]);
      expectGhDenied(["api", "repos/{owner}/{repo}/pulls/53/comments/123", "--method", "DELETE"]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "GET",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "POST",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=   ",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "POST",
        "-F",
        "body=@reply.md",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
        "-f",
        "extra=value",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/not-a-number/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/not-a-number/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
      ]);
      expectGhDenied([
        "api",
        "repos/{owner}/{repo}/pulls/53/comments/123/replies",
        "--method",
        "POST",
        "-f",
        "body=Done.",
        "--jq",
        ".id",
      ]);
    });
  });

  it("requires a subcommand unless the invocation is help/version", () => {
    expectGhDenied(["pr"]);
  });
});

// ── langfuse policy ────────────────────────────────────────────────────────

describe("validateLangfuseArgs", () => {
  describe("allowed commands", () => {
    it("allows traces list", () => {
      expect(validateLangfuseArgs(["api", "traces", "list", "--limit", "10"])).toBeNull();
    });

    it("allows sessions get", () => {
      expect(validateLangfuseArgs(["api", "sessions", "get", "abc-123"])).toBeNull();
    });

    it("allows metrics list with --query", () => {
      expect(
        validateLangfuseArgs(["api", "metrics", "list", "--query", '{"view":"observations"}']),
      ).toBeNull();
    });

    it("allows observations list with flags", () => {
      expect(
        validateLangfuseArgs([
          "api",
          "observations",
          "list",
          "--user-id",
          "uuid",
          "--type",
          "TOOL",
        ]),
      ).toBeNull();
    });

    it("allows models list", () => {
      expect(validateLangfuseArgs(["api", "models", "list"])).toBeNull();
    });

    it("allows prompts list", () => {
      expect(validateLangfuseArgs(["api", "prompts", "list"])).toBeNull();
    });

    it("allows __schema with no action", () => {
      expect(validateLangfuseArgs(["api", "__schema"])).toBeNull();
    });

    it("allows --help as action", () => {
      expect(validateLangfuseArgs(["api", "traces", "--help"])).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks non-api subcommands", () => {
      expect(validateLangfuseArgs(["get-skill"])).not.toBeNull();
    });

    it("blocks ingestions resource", () => {
      expect(validateLangfuseArgs(["api", "ingestions", "create"])).not.toBeNull();
    });

    it("blocks projects resource", () => {
      expect(validateLangfuseArgs(["api", "projects", "list"])).not.toBeNull();
    });

    it("blocks organizations resource", () => {
      expect(validateLangfuseArgs(["api", "organizations", "list"])).not.toBeNull();
    });

    it("blocks datasets resource", () => {
      expect(validateLangfuseArgs(["api", "datasets", "list"])).not.toBeNull();
    });

    it("blocks write actions", () => {
      expect(validateLangfuseArgs(["api", "traces", "create"])).not.toBeNull();
      expect(validateLangfuseArgs(["api", "traces", "update"])).not.toBeNull();
      expect(validateLangfuseArgs(["api", "traces", "delete"])).not.toBeNull();
      expect(validateLangfuseArgs(["api", "traces", "upsert"])).not.toBeNull();
    });

    it("blocks __schema with additional args", () => {
      expect(validateLangfuseArgs(["api", "__schema", "create"])).not.toBeNull();
    });

    it("blocks unknown resources", () => {
      expect(validateLangfuseArgs(["api", "unknown-thing", "list"])).not.toBeNull();
    });
  });

  describe("dangerous flags", () => {
    it("blocks --config flag", () => {
      expect(
        validateLangfuseArgs(["api", "traces", "list", "--config", "/etc/evil"]),
      ).not.toBeNull();
    });

    it("blocks --output-file flag", () => {
      expect(
        validateLangfuseArgs(["api", "traces", "list", "--output-file", "/tmp/data"]),
      ).not.toBeNull();
    });

    it("blocks --output flag", () => {
      expect(
        validateLangfuseArgs(["api", "traces", "list", "--output", "/tmp/data"]),
      ).not.toBeNull();
    });

    it("blocks --curl flag (leaks credentials)", () => {
      expect(validateLangfuseArgs(["api", "traces", "list", "--curl"])).not.toBeNull();
    });

    it("blocks --env flag (host retargeting)", () => {
      expect(validateLangfuseArgs(["api", "traces", "list", "--env", ".env"])).not.toBeNull();
    });

    it("blocks --public-key override", () => {
      expect(
        validateLangfuseArgs(["api", "traces", "list", "--public-key", "pk-evil"]),
      ).not.toBeNull();
    });

    it("blocks flags with = syntax (bypass attempt)", () => {
      expect(validateLangfuseArgs(["api", "traces", "list", "--output=/tmp/exfil"])).not.toBeNull();
      expect(validateLangfuseArgs(["api", "traces", "list", "--config=/etc/evil"])).not.toBeNull();
      expect(validateLangfuseArgs(["api", "traces", "list", "--env=.env"])).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    it("rejects empty args", () => {
      expect(validateLangfuseArgs([])).not.toBeNull();
    });

    it("rejects non-array", () => {
      expect(validateLangfuseArgs("api" as unknown as string[])).not.toBeNull();
    });

    it("rejects api with no resource", () => {
      expect(validateLangfuseArgs(["api"])).not.toBeNull();
    });

    it("rejects resource with no action", () => {
      expect(validateLangfuseArgs(["api", "traces"])).not.toBeNull();
    });
  });
});

// ── launchdarkly policy ────────────────────────────────────────────────────

describe("validateLdcliArgs", () => {
  describe("allowed commands", () => {
    it("allows list/get/help for approved resources", () => {
      expect(validateLdcliArgs(["flags", "list", "--project", "default"])).toBeNull();
      expect(
        validateLdcliArgs([
          "flags",
          "get",
          "my-flag",
          "--project",
          "default",
          "--environment",
          "production",
        ]),
      ).toBeNull();
      expect(validateLdcliArgs(["environments", "list", "--project", "default"])).toBeNull();
      expect(
        validateLdcliArgs([
          "segments",
          "list",
          "--project",
          "default",
          "--environment",
          "production",
        ]),
      ).toBeNull();
      expect(validateLdcliArgs(["metrics", "list", "--project", "default"])).toBeNull();
      expect(validateLdcliArgs(["projects", "list"])).toBeNull();
      expect(validateLdcliArgs(["flags", "--help"])).toBeNull();
      expect(validateLdcliArgs(["flags", "list", "--project", "default", "--help"])).toBeNull();
      expect(validateLdcliArgs(["flags", "list", "--help"])).toBeNull();
      expect(validateLdcliArgs(["segments", "list", "-h"])).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks mutating actions", () => {
      expect(validateLdcliArgs(["flags", "create", "--project", "default"])).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "update", "my-flag", "--project", "default"]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "delete", "my-flag", "--project", "default"]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "toggle", "my-flag", "--project", "default"]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "replace", "my-flag", "--project", "default"]),
      ).not.toBeNull();
    });

    it("blocks unsupported resources", () => {
      expect(validateLdcliArgs(["members", "list"])).not.toBeNull();
      expect(validateLdcliArgs(["teams", "list"])).not.toBeNull();
      expect(validateLdcliArgs(["config", "--list"])).not.toBeNull();
      expect(validateLdcliArgs(["config", "--set", "project", "default"])).not.toBeNull();
      expect(validateLdcliArgs(["dev-server"])).not.toBeNull();
      expect(validateLdcliArgs(["login"])).not.toBeNull();
      expect(validateLdcliArgs(["setup"])).not.toBeNull();
      expect(validateLdcliArgs(["sourcemaps", "upload"])).not.toBeNull();
      expect(validateLdcliArgs(["resources"])).not.toBeNull();
      expect(validateLdcliArgs(["audit-log", "list", "--project", "default"])).not.toBeNull();
      expect(validateLdcliArgs(["experiments", "list", "--project", "default"])).not.toBeNull();
      expect(validateLdcliArgs(["releases", "list", "--project", "default"])).not.toBeNull();
    });

    it("blocks metrics get", () => {
      expect(
        validateLdcliArgs(["metrics", "get", "my-metric", "--project", "default"]),
      ).not.toBeNull();
    });

    it("requires project scope for scoped resources", () => {
      expect(validateLdcliArgs(["flags", "list"])).not.toBeNull();
      expect(validateLdcliArgs(["environments", "list"])).not.toBeNull();
      expect(validateLdcliArgs(["segments", "list", "--environment", "production"])).not.toBeNull();
      expect(validateLdcliArgs(["metrics", "list"])).not.toBeNull();
      expect(validateLdcliArgs(["flags", "list", "--project"])).not.toBeNull();
      expect(validateLdcliArgs(["flags", "list", "--project="])).not.toBeNull();
    });

    it("blocks dangerous flags", () => {
      expect(
        validateLdcliArgs(["flags", "list", "--project", "default", "--access-token", "leaked"]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs([
          "flags",
          "get",
          "my-flag",
          "--project",
          "default",
          "--data",
          '{"on":true}',
        ]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "list", "--project", "default", "--output-file", "/tmp/x"]),
      ).not.toBeNull();
      expect(validateLdcliArgs(["flags", "list", "--project", "default", "--curl"])).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "list", "--project", "default", "--config", "/tmp/evil.yml"]),
      ).not.toBeNull();
      expect(
        validateLdcliArgs(["flags", "list", "--project", "default", "--output-file=/tmp/x"]),
      ).not.toBeNull();
    });
  });

  describe("edge cases", () => {
    it("rejects empty args", () => {
      expect(validateLdcliArgs([])).not.toBeNull();
    });

    it("rejects non-array", () => {
      expect(validateLdcliArgs("flags" as unknown as string[])).not.toBeNull();
    });

    it("rejects missing action", () => {
      expect(validateLdcliArgs(["flags"])).not.toBeNull();
    });
  });
});

// ── metabase policy ────────────────────────────────────────────────────────

describe("validateMetabaseArgs", () => {
  const originalEnv = process.env.METABASE_ALLOWED_SCHEMAS;

  beforeAll(() => {
    process.env.METABASE_ALLOWED_SCHEMAS = "dm_products,dm_growth,dw_testops";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.METABASE_ALLOWED_SCHEMAS = originalEnv;
    } else {
      delete process.env.METABASE_ALLOWED_SCHEMAS;
    }
  });

  describe("subcommand validation", () => {
    it("accepts valid subcommands", () => {
      expect(validateMetabaseArgs(["schemas"])).toBeNull();
      expect(validateMetabaseArgs(["tables", "dm_products"])).toBeNull();
      expect(validateMetabaseArgs(["columns", "dm_products", "fact_feature"])).toBeNull();
      expect(validateMetabaseArgs(["query", "SELECT 1"])).toBeNull();
    });

    it("rejects unknown subcommands", () => {
      expect(validateMetabaseArgs(["drop"])).not.toBeNull();
      expect(validateMetabaseArgs(["delete"])).not.toBeNull();
      expect(validateMetabaseArgs(["list"])).not.toBeNull();
    });

    it("rejects empty args", () => {
      expect(validateMetabaseArgs([])).not.toBeNull();
    });
  });

  describe("schemas", () => {
    it("rejects extra arguments", () => {
      expect(validateMetabaseArgs(["schemas", "extra"])).not.toBeNull();
    });
  });

  describe("tables", () => {
    it("requires exactly 1 argument", () => {
      expect(validateMetabaseArgs(["tables"])).not.toBeNull();
      expect(validateMetabaseArgs(["tables", "dm_products", "extra"])).not.toBeNull();
    });

    it("accepts allowed schema", () => {
      expect(validateMetabaseArgs(["tables", "dm_products"])).toBeNull();
      expect(validateMetabaseArgs(["tables", "dw_testops"])).toBeNull();
    });

    it("rejects non-allowed schema", () => {
      expect(validateMetabaseArgs(["tables", "dw_pii"])).not.toBeNull();
      expect(validateMetabaseArgs(["tables", "public"])).not.toBeNull();
    });
  });

  describe("columns", () => {
    it("requires exactly 2 arguments", () => {
      expect(validateMetabaseArgs(["columns"])).not.toBeNull();
      expect(validateMetabaseArgs(["columns", "dm_products"])).not.toBeNull();
      expect(validateMetabaseArgs(["columns", "dm_products", "table", "extra"])).not.toBeNull();
    });

    it("accepts allowed schema", () => {
      expect(validateMetabaseArgs(["columns", "dm_growth", "dim_account"])).toBeNull();
    });

    it("rejects non-allowed schema", () => {
      expect(validateMetabaseArgs(["columns", "dw_pii", "email_pool"])).not.toBeNull();
    });
  });

  describe("query", () => {
    it("requires exactly 1 argument (the SQL string)", () => {
      expect(validateMetabaseArgs(["query"])).not.toBeNull();
      expect(validateMetabaseArgs(["query", "SELECT 1", "extra"])).not.toBeNull();
    });

    it("accepts any SQL string (no keyword blocking)", () => {
      expect(validateMetabaseArgs(["query", "SELECT 1"])).toBeNull();
      expect(validateMetabaseArgs(["query", "SELECT * FROM dm_products.fact_feature"])).toBeNull();
      expect(validateMetabaseArgs(["query", "DROP TABLE foo"])).toBeNull();
      expect(validateMetabaseArgs(["query", "DELETE FROM bar"])).toBeNull();
    });
  });

  describe("question", () => {
    it("requires exactly 1 argument", () => {
      expect(validateMetabaseArgs(["question"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "7751", "extra"])).not.toBeNull();
    });

    it("accepts numeric ID", () => {
      expect(validateMetabaseArgs(["question", "7751"])).toBeNull();
    });

    it("accepts URL slug form", () => {
      expect(validateMetabaseArgs(["question", "7751-daily-log-web-pages-paths"])).toBeNull();
    });

    it("rejects non-numeric ID", () => {
      expect(validateMetabaseArgs(["question", "abc"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "0"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "-1"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "1e3"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "123abc"])).not.toBeNull();
      expect(validateMetabaseArgs(["question", "42/slug"])).not.toBeNull();
    });
  });
});
