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
  function expectGhDenied(args: string[]): string {
    const error = validateGhArgs(args);
    expect(error).toContain("Load skill using-gh");
    return error ?? "";
  }

  describe("allowed commands", () => {
    it("allows common gh read-only workflows", () => {
      const allowedCommands: string[][] = [
        [],
        ["--version"],
        ["--help"],
        ["auth", "status"],
        ["pr", "view"],
        ["pr", "view", "123"],
        ["pr", "view", "123", "--json", "title", "--jq", ".title"],
        ["pr", "list", "--limit", "10"],
        ["pr", "list", "--search", "is:open", "--limit", "10"],
        ["pr", "status"],
        ["pr", "checks", "123", "--watch"],
        ["pr", "diff", "123", "--patch"],
        ["issue", "view", "42"],
        ["issue", "view", "42", "--json", "title", "--jq", ".title"],
        ["issue", "list", "--limit", "10"],
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

    it("allows append-only pr/issue comments with explicit body", () => {
      expect(validateGhArgs(["pr", "comment", "123", "--body", "noted"])).toBeNull();
      expect(validateGhArgs(["pr", "comment", "123", "-b", "noted"])).toBeNull();
      expect(validateGhArgs(["issue", "comment", "42", "--body=noted"])).toBeNull();
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

    it("blocks run/workflow mutation commands", () => {
      expectGhDenied(["run", "cancel", "123"]);
      expectGhDenied(["run", "rerun", "123"]);
      expectGhDenied(["workflow", "run", "ci.yml"]);
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

    it("blocks gh pr checkout", () => {
      expectGhDenied(["pr", "checkout", "2984"]);
    });

    it("blocks repo-targeting flags across the gh surface", () => {
      expectGhDenied(["pr", "view", "123", "--repo", "owner/repo"]);
      expectGhDenied(["issue", "view", "42", "-R", "owner/repo"]);
      expectGhDenied(["repo", "view", "--repo=owner/repo"]);
      expectGhDenied(["pr", "create", "--repo", "org/repo", "--title", "x", "--body", "y"]);
    });

    it("blocks removed pr create forms", () => {
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--web"]);
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--editor"]);
      expectGhDenied(["pr", "create", "--title", "x", "--body-file", "body.md"]);
      expectGhDenied(["pr", "create", "--title", "x", "--body", "y", "--fill"]);
      expectGhDenied(["pr", "create", "--head", "feat/test", "--title", "x", "--body", "y"]);
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

    it("blocks less-central read commands removed from the allowlist", () => {
      expectGhDenied(["search", "issues", "sandbox"]);
      expectGhDenied(["label", "list"]);
      expectGhDenied(["release", "list"]);
    });
  });

  describe("gh api", () => {
    it("blocks unsafe gh api execution forms", () => {
      expectGhDenied(["api", "graphql"]);
      expectGhDenied(["api", "-X", "GET", "repos/org/repo"]);
      expectGhDenied(["api", "repos/org/repo", "--method", "GET"]);
      expectGhDenied(["api", "repos/org/repo", "--input", "body.json"]);
      expectGhDenied(["api", "repos/org/repo", "-H", "Accept: application/json"]);
      expectGhDenied(["api", "repos/org/repo", "--preview", "corsair"]);
      expectGhDenied(["api", "repos/org/repo", "--hostname", "ghe.example.com"]);
      expectGhDenied(["api", "repos/org/repo", "-f", "state=open"]);
      expectGhDenied(["api", "repos/org/repo", "-F", "q=@query.graphql"]);
      expectGhDenied(["api", "--silent", "repos/org/repo"]);
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
});
