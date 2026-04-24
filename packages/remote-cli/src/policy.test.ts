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
  function expectGitDenied(args: string[]): string {
    const error = validateGitArgs(args);
    expect(error).toContain("Load skill using-git");
    return error ?? "";
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
        ["branch", "--show-current"],
        ["branch", "-a"],
        ["merge-base", "HEAD", "origin/main"],
        ["fetch", "origin"],
        ["fetch", "origin", "main"],
        ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"],
        ["remote"],
        ["remote", "-v"],
        ["remote", "show", "origin"],
        ["remote", "get-url", "origin"],
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
        ["add", "docs/plan/2026042401_command-usage-regression-tests.md"],
        ["add", "-A"],
        ["add", "packages/remote-cli/src/policy.ts", "packages/remote-cli/src/policy.test.ts"],
        ["commit", "-m", "test: expand git and gh policy coverage"],
        ["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat"],
        ["worktree", "add", "-b", "feat", "/workspace/worktrees/repo/feat", "origin/main"],
        ["push", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "--dry-run", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "-u", "origin", "HEAD:refs/heads/feat/x"],
        ["push", "--set-upstream", "origin", "HEAD:refs/heads/feat/x"],
      ];

      for (const args of allowedCommands) {
        expect(validateGitArgs(args)).toBeNull();
      }
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

    it("blocks worktree add outside /workspace/worktrees/", () => {
      expectGitDenied(["worktree", "add", "-b", "feat", "/tmp/evil"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/repos/sneaky"]);
      expectGitDenied(["worktree", "add", "-b", "feat", "/workspace/worktrees/../repos/escape"]);
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

    it("blocks non-allowlisted branch commands", () => {
      expectGitDenied(["branch", "-m", "rename-policy-tests"]);
      expectGitDenied(["branch", "--list"]);
    });

    it("blocks git remote add/set-url/rename/remove and other unsupported shapes", () => {
      expectGitDenied(["remote", "add", "evil", "https://evil.com/repo.git"]);
      expectGitDenied(["remote", "set-url", "origin", "https://evil.com/repo.git"]);
      expectGitDenied(["remote", "rename", "origin", "old"]);
      expectGitDenied(["remote", "remove", "origin"]);
      expectGitDenied(["remote", "prune", "origin"]);
    });

    it("blocks fetches outside the allowlist", () => {
      expectGitDenied(["fetch", "upstream"]);
      expectGitDenied(["fetch", "origin", "--tags"]);
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
