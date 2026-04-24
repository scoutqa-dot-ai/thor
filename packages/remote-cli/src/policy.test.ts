import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  resolveGitArgs,
  validateCwd,
  validateGitArgs,
  validateGhArgs,
  validateLdcliArgs,
  validateLangfuseArgs,
  validateMetabaseArgs,
} from "./policy.js";

interface TestRepoOptions {
  branch?: string;
  upstreamBranch?: string;
  upstreamRemote?: string;
  detachedHead?: boolean;
}

function createRepoWithOrigin(remoteUrl: string, options: TestRepoOptions = {}): string {
  const {
    branch = "main",
    upstreamBranch,
    upstreamRemote = "origin",
    detachedHead = false,
  } = options;
  const dir = mkdtempSync(join(tmpdir(), "thor-policy-gh-"));
  execFileSync("/usr/bin/git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Thor Policy"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("/usr/bin/git", ["config", "user.email", "thor-policy@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "seed\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["branch", "-M", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["remote", "add", "origin", remoteUrl], {
    cwd: dir,
    stdio: "ignore",
  });
  if (upstreamBranch) {
    execFileSync("/usr/bin/git", ["config", "--local", `branch.${branch}.remote`, upstreamRemote], {
      cwd: dir,
      stdio: "ignore",
    });
    execFileSync(
      "/usr/bin/git",
      ["config", "--local", `branch.${branch}.merge`, `refs/heads/${upstreamBranch}`],
      { cwd: dir, stdio: "ignore" },
    );
  }
  if (detachedHead) {
    execFileSync("/usr/bin/git", ["checkout", "--detach", "HEAD"], { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

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

    it("allows common git read-only workflows", () => {
      const allowedCommands: string[][] = [
        ["--version"],
        ["--no-pager", "log", "--oneline", "-10"],
        ["status", "--short"],
        ["log", "--oneline", "-5"],
        ["log", "origin/main..HEAD", "--oneline"],
        ["diff", "--stat"],
        ["diff", "origin/main", "--stat"],
        ["diff", "origin/main", "--", "packages/remote-cli/src/policy.ts"],
        ["show", "HEAD~1"],
        ["show", "HEAD", "--stat"],
        ["show", "HEAD:packages/remote-cli/src/policy.ts"],
        ["branch", "--show-current"],
        ["branch", "-a"],
        ["rev-parse", "HEAD"],
        ["merge-base", "HEAD", "origin/main"],
        ["config", "--get", "remote.origin.url"],
        ["config", "--show-origin", "--get-regexp", "^remote\\..*url$"],
        ["check-ignore", "-v", "docs/plan/2026042401_command-usage-regression-tests.md"],
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        ["check-ref-format", "--branch", "feat/test"],
        ["check-ref-format", "refs/heads/feat/test"],
        ["fetch", "origin"],
        ["fetch", "origin", "main"],
        ["pull", "origin", "feat/x"],
        ["remote"],
        ["remote", "-v"],
        ["remote", "show", "origin"],
        ["remote", "get-url", "origin"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
    });

    it("allows restore-only git checkout flows without reopening branch switching", () => {
      const allowedCommands: string[][] = [
        ["checkout", "--", "package-lock.json"],
        ["checkout", "HEAD~1", "--", "packages/remote-cli/src/policy.ts"],
        ["checkout", "origin/main", "--", "."],
        ["checkout", "--theirs", "packages/remote-cli/src/policy.ts"],
        ["checkout", "packages/remote-cli/src/policy.ts"],
        // After `--`, git grammar guarantees pathspec; extensionless files
        // (Dockerfile, Makefile, LICENSE, bin/*) must not be blocked.
        ["checkout", "--", "Dockerfile"],
        ["checkout", "--", "Makefile"],
        ["checkout", "--", "LICENSE"],
        ["checkout", "--", "bin/migrate"],
        ["checkout", "HEAD", "--", "Dockerfile"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
    });

    it("allows common git write workflows that stay inside the current repo", () => {
      const allowedCommands: string[][] = [
        ["branch", "-m", "rename-policy-tests"],
        ["add", "docs/plan/2026042401_command-usage-regression-tests.md"],
        ["add", "-A"],
        ["add", "packages/remote-cli/src/policy.ts", "packages/remote-cli/src/policy.test.ts"],
        ["commit", "-m", "test: expand git and gh policy coverage"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
    });

    it("allows push to origin", () => {
      expect(validateGitArgs(["push", "origin", "my-branch"])).toBeNull();
    });

    it("allows implicit push when the current branch has a safe origin upstream", () => {
      const repoDir = createRepoWithOrigin("https://github.com/acme/web.git", {
        branch: "feat/test",
        upstreamBranch: "feat/test",
      });

      try {
        expect(validateGitArgs(["push"], repoDir)).toBeNull();
        expect(validateGitArgs(["push", "origin"], repoDir)).toBeNull();
        expect(validateGitArgs(["push", "--dry-run"], repoDir)).toBeNull();

        expect(resolveGitArgs(["push"], repoDir)).toEqual({
          args: ["push", "origin", "HEAD:refs/heads/feat/test"],
        });
        expect(resolveGitArgs(["push", "origin"], repoDir)).toEqual({
          args: ["push", "origin", "HEAD:refs/heads/feat/test"],
        });
        expect(resolveGitArgs(["push", "--dry-run"], repoDir)).toEqual({
          args: ["push", "--dry-run", "origin", "HEAD:refs/heads/feat/test"],
        });
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
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

    it("blocks leading git flags before the subcommand", () => {
      expect(validateGitArgs(["-C", "/tmp", "status"])).not.toBeNull();
      expect(validateGitArgs(["-c", "credential.helper=!evil", "push", "origin"])).not.toBeNull();
      expect(validateGitArgs(["--exec-path=/tmp/evil", "status"])).not.toBeNull();
    });

    it("blocks checkout and switch with a git worktree hint", () => {
      expect(validateGitArgs(["checkout", "main"])).toContain("git worktree add");
      expect(validateGitArgs(["switch", "feature"])).toContain("git worktree add");
      expect(validateGitArgs(["checkout", "docs/pre-release"])).toContain("git worktree add");
      expect(validateGitArgs(["checkout", "-b", "feat/test", "origin/main"])).toContain(
        "git worktree add",
      );
      expect(validateGitArgs(["checkout", "-f", "review/pr-1569"])).toContain("git worktree add");
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

    it("blocks security-sensitive push flags", () => {
      expect(validateGitArgs(["push", "--receive-pack=evil", "origin"])).not.toBeNull();
      expect(validateGitArgs(["push", "--repo=https://evil.com", "origin"])).not.toBeNull();
      expect(validateGitArgs(["push", "--exec=evil", "origin"])).not.toBeNull();
    });

    it("rejects unknown push flags but keeps known safe ones working", () => {
      expect(validateGitArgs(["push", "--some-unknown-flag", "origin"])).not.toBeNull();
      expect(validateGitArgs(["push", "--no-verify", "origin", "feat/x"])).toBeNull();
      expect(validateGitArgs(["push", "--force-with-lease", "origin", "main"])).not.toBeNull();
    });

    it("blocks --force-with-lease with an inline value", () => {
      expect(
        validateGitArgs(["push", "--force-with-lease=main:abc123", "origin", "main"]),
      ).not.toBeNull();
    });

    it("requires explicit remote and explicit refspec when no safe upstream can be resolved", () => {
      expect(validateGitArgs(["push"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin"])).not.toBeNull();
      expect(validateGitArgs(["push", "HEAD"])).not.toBeNull();
    });

    it("blocks implicit push when the current branch has no upstream", () => {
      const repoDir = createRepoWithOrigin("https://github.com/acme/web.git", {
        branch: "feat/test",
      });

      try {
        expect(validateGitArgs(["push"], repoDir)).not.toBeNull();
        expect(validateGitArgs(["push", "origin"], repoDir)).not.toBeNull();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("blocks implicit push when the upstream remote is not origin", () => {
      const repoDir = createRepoWithOrigin("https://github.com/acme/web.git", {
        branch: "feat/test",
        upstreamBranch: "feat/test",
        upstreamRemote: "upstream",
      });

      try {
        expect(validateGitArgs(["push"], repoDir)).not.toBeNull();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("blocks implicit push when the upstream branch is protected", () => {
      const repoDir = createRepoWithOrigin("https://github.com/acme/web.git", {
        branch: "feat/test",
        upstreamBranch: "main",
      });

      try {
        expect(validateGitArgs(["push"], repoDir)).not.toBeNull();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("blocks implicit push from detached HEAD", () => {
      const repoDir = createRepoWithOrigin("https://github.com/acme/web.git", {
        branch: "feat/test",
        upstreamBranch: "feat/test",
        detachedHead: true,
      });

      try {
        expect(validateGitArgs(["push"], repoDir)).not.toBeNull();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("allows -u / --set-upstream to set upstream tracking", () => {
      expect(validateGitArgs(["push", "-u", "origin", "feat/x"])).toBeNull();
      expect(validateGitArgs(["push", "--set-upstream", "origin", "feat/x"])).toBeNull();
    });

    it("blocks pushes to protected target branches", () => {
      expect(validateGitArgs(["push", "origin", "main"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "master"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "HEAD:refs/heads/main"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "HEAD:refs/heads/master"])).not.toBeNull();
    });

    it("blocks previously-allowed push flags now removed from the surface", () => {
      expect(validateGitArgs(["push", "--force", "origin", "main"])).not.toBeNull();
      expect(validateGitArgs(["push", "-f", "origin", "main"])).not.toBeNull();
      expect(validateGitArgs(["push", "--delete", "origin", "feat/x"])).not.toBeNull();
      expect(validateGitArgs(["push", "-d", "origin", "feat/x"])).not.toBeNull();
    });

    it("allows explicit HEAD refspecs and blocks dangerous mapped refspecs", () => {
      expect(validateGitArgs(["push", "origin", "HEAD:refs/heads/feat/auth"])).toBeNull();
      expect(validateGitArgs(["push", "origin", "+HEAD:refs/heads/main"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "main:refs/heads/other"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "HEAD:refs/tags/v1"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", ":main"])).not.toBeNull();
      expect(validateGitArgs(["push", "origin", "HEAD:refs/heads/foo:bar"])).not.toBeNull();
    });

    it("blocks write-oriented git config operations", () => {
      expect(validateGitArgs(["config", "--global", "--get", "user.name"])).not.toBeNull();
      expect(validateGitArgs(["config", "user.name", "Thor"])).not.toBeNull();
    });

    it("blocks non-read-only git --no-pager usage", () => {
      expect(validateGitArgs(["--no-pager", "push", "origin", "feat/x"])).not.toBeNull();
    });

    it("blocks git check-ignore modes that can read from stdin", () => {
      expect(validateGitArgs(["check-ignore", "--stdin"])).not.toBeNull();
    });

    it("blocks git symbolic-ref mutation shapes", () => {
      expect(validateGitArgs(["symbolic-ref", "HEAD", "refs/heads/main"])).not.toBeNull();
      expect(
        validateGitArgs(["symbolic-ref", "-m", "update", "HEAD", "refs/heads/main"]),
      ).not.toBeNull();
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

  it("rejects leading flags that are not explicitly allowlisted", () => {
    expect(validateGitArgs(["--exec-path=/tmp/evil"])).not.toBeNull();
  });
});

// ── gh policy ───────────────────────────────────────────────────────────────

describe("validateGhArgs", () => {
  let ghRepoDir: string;

  beforeAll(() => {
    ghRepoDir = createRepoWithOrigin("https://github.com/acme/web.git");
  });

  afterAll(() => {
    rmSync(ghRepoDir, { recursive: true, force: true });
  });

  describe("allowed commands", () => {
    it("allows common gh read-only workflows", () => {
      const allowedCommands: string[][] = [
        [],
        ["--version"],
        ["auth", "status"],
        ["pr", "view", "123"],
        ["pr", "view", "123", "--json", "title", "--jq", ".title"],
        ["pr", "view", "123", "-R", "owner/repo", "--json", "title", "--jq", ".title"],
        ["pr", "list", "--limit", "10"],
        ["pr", "list", "--search", "is:open", "--limit", "10"],
        ["pr", "status"],
        ["pr", "checks", "123"],
        ["pr", "diff", "123"],
        ["issue", "view", "42"],
        ["issue", "view", "42", "--repo", "owner/repo", "--json", "title", "--jq", ".title"],
        ["issue", "list", "--limit", "10"],
        ["repo", "view"],
        [
          "repo",
          "view",
          "owner/repo",
          "--json",
          "defaultBranchRef",
          "-q",
          ".defaultBranchRef.name",
        ],
        ["run", "list"],
        ["run", "view", "123"],
        ["run", "view", "123", "--repo", "owner/repo"],
        ["run", "watch", "123", "--exit-status"],
        ["search", "issues", "--repo", "anomalyco/opencode", "sandbox", "--limit", "10"],
        ["search", "prs", "--repo", "anomalyco/opencode", "container sandbox", "--limit", "10"],
        [
          "search",
          "code",
          "x-opencode-directory",
          "--repo",
          "anomalyco/opencode",
          "--json",
          "path,textMatches",
          "-L",
          "10",
        ],
        ["search", "repos", "opencode", "--limit", "5", "--json", "fullName,description"],
        ["workflow", "list"],
        ["workflow", "view", "ci.yml"],
      ];

      for (const args of allowedCommands) {
        expect(validateGhArgs(args)).toBeNull();
      }
    });

    it("allows gh help and command introspection flows while keeping gh api help blocked", () => {
      const allowedCommands: string[][] = [
        ["help"],
        ["help", "formatting"],
        ["help", "environment"],
        ["pr", "--help"],
        ["pr", "create", "--help"],
        ["pr", "comment", "--help"],
        ["pr", "review", "--help"],
        ["issue", "--help"],
        ["issue", "status", "--help"],
        ["search", "--help"],
        ["run", "--help"],
        ["workflow", "--help"],
        ["repo", "--help"],
        ["label", "--help"],
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
          "--head",
          "feat/test",
          "--base",
          "main",
          "--title",
          "Add feature",
          "--body",
          "Summary",
        ]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "create", "--title=Add feature", "--body=Summary"])).toBeNull();
      expect(
        validateGhArgs([
          "pr",
          "create",
          "--head=feat/test",
          "--title=Add feature",
          "--body=Summary",
        ]),
      ).toBeNull();
    });

    it("allows append-only pr/issue comments with explicit body", () => {
      expect(validateGhArgs(["pr", "comment", "--body", "noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "--body", "noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "-b", "noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "feat/test", "--body", "noted"])).toBeNull();
      expect(
        validateGhArgs(
          ["pr", "comment", "https://github.com/acme/web/pull/123", "--body", "noted"],
          ghRepoDir,
        ),
      ).toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--body=noted"])).toBeNull();
      expect(
        validateGhArgs(
          ["issue", "comment", "https://github.com/acme/web/issues/42", "--body=noted"],
          ghRepoDir,
        ),
      ).toBeNull();
    });

    it("allows append-only pr reviews for comment/request-changes", () => {
      expect(validateGhArgs(["pr", "review", "--comment", "--body", "LGTM-ish"])).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "--comment", "--body", "LGTM-ish"])).toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--request-changes", "--body", "needs tests"]),
      ).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "-c", "-b", "review body"])).toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "-r", "--body=review body"])).toBeNull();
      expect(
        validateGhArgs(["pr", "review", "feat/test", "--comment", "--body", "LGTM-ish"]),
      ).toBeNull();
      expect(
        validateGhArgs(
          [
            "pr",
            "review",
            "https://github.com/acme/web/pull/123",
            "--comment",
            "--body",
            "LGTM-ish",
          ],
          ghRepoDir,
        ),
      ).toBeNull();
    });
  });

  describe("blocked commands", () => {
    it("blocks non-append-only pr state mutation commands", () => {
      expect(validateGhArgs(["pr", "edit", "123", "--title", "new"])).not.toBeNull();
      expect(validateGhArgs(["pr", "ready", "123"])).not.toBeNull();
    });

    it("blocks pr merge", () => {
      expect(validateGhArgs(["pr", "merge", "123"])).not.toBeNull();
    });

    it("blocks run/workflow mutation commands", () => {
      expect(validateGhArgs(["run", "cancel", "123"])).not.toBeNull();
      expect(validateGhArgs(["run", "rerun", "123"])).not.toBeNull();
      expect(validateGhArgs(["workflow", "run", "ci.yml"])).not.toBeNull();
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

    it("blocks gh api help even though other help flows are allowed", () => {
      expect(validateGhArgs(["api", "--help"])).not.toBeNull();
      expect(validateGhArgs(["help", "api"])).not.toBeNull();
    });

    it("does not route mutations to the help validator when --help/-h appears as a flag value", () => {
      // -h / --help as the value of --body must not short-circuit validation.
      // The comment validator still runs, so append-only shape is preserved.
      expect(validateGhArgs(["pr", "comment", "123", "--body", "-h"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "--body", "see --help for more"])).toBeNull();
      // --approve must still be blocked even with --help buried in --body.
      expect(
        validateGhArgs(["pr", "review", "123", "--approve", "--body", "--help"]),
      ).not.toBeNull();
    });

    it("blocks secret commands", () => {
      expect(validateGhArgs(["secret", "set", "FOO"])).not.toBeNull();
    });

    it("blocks gh pr checkout with a git worktree hint", () => {
      const err = validateGhArgs(["pr", "checkout", "2984"]);
      expect(err).toContain("git worktree add");
      expect(err).toContain("pull/<N>/head");
    });

    it("blocks interactive and file-based pr create flags", () => {
      expect(
        validateGhArgs(["pr", "create", "--title", "x", "--body", "y", "--web"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "create", "--title", "x", "--body", "y", "--editor"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "create", "--title", "x", "--body-file", "body.md"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "create", "--title", "x", "--body", "y", "--fill"]),
      ).not.toBeNull();
    });

    it("requires pr create to include --title and --body", () => {
      expect(validateGhArgs(["pr", "create", "--title", "x"])).not.toBeNull();
      expect(validateGhArgs(["pr", "create", "--body", "y"])).not.toBeNull();
      expect(validateGhArgs(["pr", "create", "--title"])).not.toBeNull();
      expect(validateGhArgs(["pr", "create", "--body"])).not.toBeNull();
    });

    it("blocks cross-repo head selectors for pr create", () => {
      expect(
        validateGhArgs([
          "pr",
          "create",
          "--head",
          "otheruser:feat/test",
          "--title",
          "x",
          "--body",
          "y",
        ]),
      ).not.toBeNull();
      expect(
        validateGhArgs([
          "pr",
          "create",
          "--head=otheruser:feat/test",
          "--title",
          "x",
          "--body",
          "y",
        ]),
      ).not.toBeNull();
    });

    it("blocks cross-repo flags for gh write commands", () => {
      expect(
        validateGhArgs(["pr", "create", "--repo", "org/repo", "--title", "x", "--body", "y"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "create", "-R", "org/repo", "--title", "x", "--body", "y"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "comment", "123", "--repo", "org/repo", "--body", "x"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["issue", "comment", "42", "-R", "org/repo", "--body", "x"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--comment", "--repo", "org/repo", "--body", "x"]),
      ).not.toBeNull();
      expect(
        validateGhArgs([
          "pr",
          "review",
          "123",
          "--request-changes",
          "-R",
          "org/repo",
          "--body",
          "x",
        ]),
      ).not.toBeNull();
    });

    it("blocks comment edit/delete/interactive/file flags", () => {
      expect(validateGhArgs(["pr", "comment", "123", "--edit-last", "--body", "x"])).not.toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "--delete-last"])).not.toBeNull();
      expect(
        validateGhArgs(["issue", "comment", "42", "--create-if-none", "--body", "x"]),
      ).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--web", "--body", "x"])).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--editor", "--body", "x"])).not.toBeNull();
      expect(
        validateGhArgs(["issue", "comment", "42", "--body-file", "comment.md"]),
      ).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "-F", "comment.md"])).not.toBeNull();
    });

    it("requires comments to provide --body", () => {
      expect(validateGhArgs(["pr", "comment", "123"])).not.toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "--body"])).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--repo"])).not.toBeNull();
    });

    it("blocks cross-repo URL selectors and repo-style shorthands for gh write comment/review commands", () => {
      expect(
        validateGhArgs(
          ["pr", "comment", "https://github.com/other/repo/pull/123", "--body", "x"],
          ghRepoDir,
        ),
      ).not.toBeNull();
      expect(
        validateGhArgs(
          ["issue", "comment", "https://github.com/other/repo/issues/42", "--body", "x"],
          ghRepoDir,
        ),
      ).not.toBeNull();
      expect(
        validateGhArgs(
          ["pr", "review", "https://github.com/other/repo/pull/123", "--comment", "--body", "x"],
          ghRepoDir,
        ),
      ).not.toBeNull();
      expect(validateGhArgs(["pr", "comment", "owner/repo#123", "--body", "x"])).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "abc", "--body", "x"])).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "owner/repo#123", "--comment", "--body", "x"]),
      ).not.toBeNull();
    });

    it("rejects extra positional selectors for gh write comment/review commands", () => {
      expect(validateGhArgs(["pr", "comment", "123", "124", "--body", "x"])).not.toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "43", "--body", "x"])).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "124", "--comment", "--body", "x"]),
      ).not.toBeNull();
    });

    it("requires issue comment to include a numeric issue selector", () => {
      expect(validateGhArgs(["issue", "comment", "--body", "x"])).not.toBeNull();
    });

    it("blocks unknown comment flags", () => {
      expect(
        validateGhArgs(["pr", "comment", "123", "--foo", "bar", "--body", "x"]),
      ).not.toBeNull();
    });

    it("blocks pr review approve and interactive/file/unknown flags", () => {
      expect(validateGhArgs(["pr", "review", "123", "--approve", "--body", "ok"])).not.toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "-a", "-b", "ok"])).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--comment", "--web", "--body", "ok"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--request-changes", "--editor", "--body", "x"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--comment", "--body-file", "review.md"]),
      ).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--comment", "--foo", "x", "--body", "ok"]),
      ).not.toBeNull();
    });

    it("requires pr review mode and --body", () => {
      expect(validateGhArgs(["pr", "review", "123", "--body", "x"])).not.toBeNull();
      expect(validateGhArgs(["pr", "review", "123", "--comment"])).not.toBeNull();
      expect(
        validateGhArgs(["pr", "review", "123", "--comment", "--request-changes", "--body", "x"]),
      ).not.toBeNull();
    });
  });

  describe("gh api", () => {
    it("blocks gh api entirely", () => {
      expect(validateGhArgs(["api", "--help"])).not.toBeNull();
      expect(validateGhArgs(["api", "repos/org/repo/pulls"])).not.toBeNull();
      expect(validateGhArgs(["api", "-X", "GET", "repos/org/repo"])).not.toBeNull();
      expect(validateGhArgs(["api", "-X", "POST", "repos/org/repo/pulls"])).not.toBeNull();
      expect(validateGhArgs(["api", "graphql"])).not.toBeNull();
    });
  });

  it("requires a subcommand unless the invocation is help/version", () => {
    expect(validateGhArgs(["pr"])).not.toBeNull();
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
});
