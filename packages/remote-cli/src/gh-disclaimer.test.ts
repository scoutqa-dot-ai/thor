import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { normalize as normalizePosix } from "node:path/posix";
import {
  appendAlias,
  appendSessionEvent,
  formatThorContextFooter,
  resolveAlias,
} from "@thor/common";

vi.hoisted(() => {
  process.env.WORKLOG_DIR = "/tmp/thor-remote-cli-gh-test/worklog";
  process.env.RUNNER_BASE_URL = "https://thor.example.com";
});

const execCalls = vi.hoisted(() => [] as Array<{ bin: string; args: string[]; cwd: string }>);

vi.mock("./exec.js", () => ({
  execCommand: vi.fn(async (bin: string, args: string[], cwd: string) => {
    execCalls.push({ bin, args, cwd });
    if (bin === "gh" && args[0] === "issue" && args[1] === "create") {
      return { stdout: "https://github.com/acme/thor/issues/42\n", stderr: "", exitCode: 0 };
    }
    if (bin === "gh" && args[0] === "issue" && args[1] === "comment") {
      return {
        stdout: "https://github.com/acme/thor/issues/42#issuecomment-1\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }),
  execCommandStream: vi.fn(),
}));

import { createRemoteCliApp, type RemoteCliAppConfig } from "./index.js";

const worklogRoot = "/tmp/thor-remote-cli-gh-test";
const cwd = "/workspace/worktrees/acme/feat/test";
const triggerId = "00000000-0000-7000-8000-000000000201";
const secondTriggerId = "00000000-0000-7000-8000-000000000202";
const anchorParent = "00000000-0000-7000-8000-0000000003a1";
const anchorSuperseded = "00000000-0000-7000-8000-0000000003a2";
const anchorChild = "00000000-0000-7000-8000-0000000003a3";

function bindSessionToAnchor(sessionId: string, anchorId: string): void {
  appendAlias({
    aliasType: "opencode.session",
    aliasValue: sessionId,
    anchorId,
  });
}

async function withServer<T>(fn: (url: string) => Promise<T>, config?: RemoteCliAppConfig): Promise<T> {
  const remoteCli = createRemoteCliApp(config);
  const server: Server = createServer(remoteCli.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await remoteCli.close();
  }
}

async function postGh(url: string, args: string[], sessionId?: string) {
  const response = await fetch(`${url}/exec/gh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-thor-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ args, cwd }),
  });
  return {
    response,
    body: (await response.json()) as { stdout: string; stderr: string; exitCode: number },
  };
}

async function postGit(url: string, args: string[], sessionId?: string) {
  const response = await fetch(`${url}/exec/git`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-thor-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ args, cwd }),
  });
  return {
    response,
    body: (await response.json()) as { stdout: string; stderr: string; exitCode: number },
  };
}

function readAliases(): Array<{ aliasType: string; aliasValue: string; anchorId: string }> {
  try {
    return readFileSync(`${process.env.WORKLOG_DIR}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

beforeEach(() => {
  execCalls.length = 0;
  process.env.WORKLOG_DIR = "/tmp/thor-remote-cli-gh-test/worklog";
  rmSync(worklogRoot, { recursive: true, force: true });
  vi.spyOn(realpathSync, "native").mockImplementation((path) => normalizePosix(String(path)));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(worklogRoot, { recursive: true, force: true });
});

describe("gh disclaimer injection", () => {
  function seedActor(sessionId = "parent") {
    bindSessionToAnchor(sessionId, anchorParent);
    appendSessionEvent(sessionId, {
      type: "trigger_start",
      triggerId,
      triggerSlackId: "UABCDEF1",
    });
  }

  const configLoader = () => ({
    users: [{ email: "alice@example.com", name: "Alice", slack: "UABCDEF1", github: "alice" }],
  });

  it("appends a co-author trailer to git commit -m", async () => {
    seedActor();
    await withServer(async (url) => {
      const { response } = await postGit(url, ["commit", "-m", "Do work"], "parent");
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toEqual([
        "commit",
        "-m",
        "Do work\n\nCo-authored-by: Alice <alice@example.com>",
      ]);
    }, { configLoader });
  });

  it("appends co-author trailer after one blank line when message already ends with newline", async () => {
    seedActor();
    await withServer(async (url) => {
      await postGit(url, ["commit", "-m", "Do work\n"], "parent");
      expect(execCalls[0].args[2]).toBe("Do work\n\nCo-authored-by: Alice <alice@example.com>");
    }, { configLoader });
  });

  it("preserves CRLF style when appending after a CRLF-terminated message", async () => {
    seedActor();
    await withServer(async (url) => {
      await postGit(url, ["commit", "-m", "Do work\r\n"], "parent");
      expect(execCalls[0].args[2]).toBe("Do work\r\n\r\nCo-authored-by: Alice <alice@example.com>");
    }, { configLoader });
  });

  it("adds a PR assignee when gh pr create has none", async () => {
    seedActor();
    await withServer(async (url) => {
      const { response } = await postGh(url, ["pr", "create", "--title", "x", "--body", "Body"], "parent");
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toContain("--assignee");
      expect(execCalls[0].args).toContain("alice");
    }, { configLoader });
  });

  it("keeps an existing PR assignee", async () => {
    seedActor();
    await withServer(async (url) => {
      await postGh(url, ["pr", "create", "--title", "x", "--body", "Body", "--assignee", "bob"], "parent");
      expect(execCalls[0].args.filter((arg) => arg === "--assignee")).toHaveLength(1);
      expect(execCalls[0].args).toContain("bob");
    }, { configLoader });
  });

  it("keeps git and gh attribution best-effort when config loading fails", async () => {
    seedActor();
    const failingConfigLoader = () => {
      throw new Error("config unavailable");
    };
    await withServer(async (url) => {
      const git = await postGit(url, ["commit", "-m", "Do work"], "parent");
      expect(git.response.status).toBe(200);
      expect(execCalls[0].args).toEqual(["commit", "-m", "Do work"]);

      const gh = await postGh(url, ["pr", "create", "--title", "x", "--body", "Body"], "parent");
      expect(gh.response.status).toBe(200);
      expect(execCalls[1].args).not.toContain("--assignee");
    }, { configLoader: failingConfigLoader });
  });

  it("validates effective git cwd before attempting attribution", async () => {
    seedActor();
    const failingConfigLoader = () => {
      throw new Error("config unavailable");
    };
    await withServer(async (url) => {
      const { response, body } = await postGit(
        url,
        ["-C", "/not/allowed", "commit", "-m", "Do work"],
        "parent",
      );
      expect(response.status).toBe(400);
      expect(body.exitCode).toBe(1);
      expect(body.stderr).toContain('"git -C" is not allowed.');
      expect(execCalls).toEqual([]);
    }, { configLoader: failingConfigLoader });
  });

  it("registers git branch aliases only after successful git push", async () => {
    bindSessionToAnchor("parent", anchorParent);

    await withServer(async (url) => {
      const { response } = await postGit(
        url,
        ["push", "origin", "HEAD:refs/heads/feat/test"],
        "parent",
      );

      expect(response.status).toBe(200);
      expect(execCalls[0]).toMatchObject({
        bin: "git",
        args: ["push", "origin", "HEAD:refs/heads/feat/test"],
      });
    });

    const aliases = readAliases().filter((alias) => alias.aliasType === "git.branch");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      aliasType: "git.branch",
      aliasValue: Buffer.from("git:branch:acme:feat/test").toString("base64url"),
      anchorId: anchorParent,
    });
  });

  it("does not register git branch aliases for dry-run push, worktree add, or gh pr create", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const dryRun = await postGit(
        url,
        ["push", "--dry-run", "origin", "HEAD:refs/heads/feat/test"],
        "parent",
      );
      expect(dryRun.response.status).toBe(200);

      const worktree = await postGit(
        url,
        ["worktree", "add", "/workspace/worktrees/acme/feat/test", "feat/test"],
        "parent",
      );
      expect(worktree.response.status).toBe(200);

      const pr = await postGh(url, ["pr", "create", "--title", "x", "--body", "body"], "parent");
      expect(pr.response.status).toBe(200);
    });

    expect(readAliases().filter((alias) => alias.aliasType === "git.branch")).toEqual([]);
  });

  it("passes mutating command help requests without requiring a Thor session", async () => {
    await withServer(async (url) => {
      const commands = [
        ["pr", "create", "--help"],
        ["pr", "comment", "--help"],
        ["issue", "comment", "--help"],
        ["pr", "review", "-h"],
      ];

      for (const args of commands) {
        const { response } = await postGh(url, args);
        expect(response.status).toBe(200);
      }

      expect(execCalls.map((call) => call.args)).toEqual(commands);
    });
  });

  it("fails closed without a Thor session id", async () => {
    await withServer(async (url) => {
      const { response, body } = await postGh(url, ["pr", "comment", "123", "--body", "note"]);
      expect(response.status).toBe(400);
      expect(body.stderr).toContain("missing Thor session id");
      const issue = await postGh(url, ["issue", "comment", "42", "--body", "note"]);
      expect(issue.response.status).toBe(400);
      expect(issue.body.stderr).toContain("missing Thor session id");
      expect(execCalls).toHaveLength(0);
    });
  });

  it("injects into issue comment bodies", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        ["issue", "comment", "42", "--body", "note"],
        "parent",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toEqual([
        "issue",
        "comment",
        "42",
        "--body",
        `note
${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorParent}/${triggerId}`)}`,
      ]);
      expect(
        resolveAlias({
          aliasType: "github.issue",
          aliasValue: Buffer.from("github:issue:thor:acme/thor#42").toString("base64url"),
        }),
      ).toBe(anchorParent);
    });
  });

  it("injects into issue create bodies and binds the created issue alias with GitHub repo basename", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        ["issue", "create", "--title", "Bug", "--body", "Broken"],
        "parent",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toEqual([
        "issue",
        "create",
        "--title",
        "Bug",
        "--body",
        `Broken\n${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorParent}/${triggerId}`)}`,
      ]);
      expect(
        resolveAlias({
          aliasType: "github.issue",
          aliasValue: Buffer.from("github:issue:thor:acme/thor#42").toString("base64url"),
        }),
      ).toBe(anchorParent);
    });
  });

  it("fails closed when the session has no anchor context", async () => {
    await withServer(async (url) => {
      const missing = await postGh(url, ["pr", "comment", "123", "--body", "note"], "missing");
      expect(missing.response.status).toBe(400);
      expect(missing.body.stderr).toContain("(none)");
      expect(execCalls).toHaveLength(0);
    });
  });

  it("injects anchor footers when the session has no active trigger", async () => {
    bindSessionToAnchor("idle", anchorParent);

    await withServer(async (url) => {
      const { response } = await postGh(url, ["pr", "comment", "123", "--body", "note"], "idle");
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toEqual([
        "pr",
        "comment",
        "123",
        "--body",
        `note\n${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorParent}`)}`,
      ]);
    });
  });

  it("uses the latest trigger when a previous orphaned trigger was superseded", async () => {
    bindSessionToAnchor("superseded", anchorSuperseded);
    appendSessionEvent("superseded", { type: "trigger_start", triggerId });
    appendSessionEvent("superseded", { type: "trigger_start", triggerId: secondTriggerId });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        ["pr", "comment", "123", "--body", "note"],
        "superseded",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0].args).toEqual([
        "pr",
        "comment",
        "123",
        "--body",
        `note\n${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorSuperseded}/${secondTriggerId}`)}`,
      ]);
    });
  });

  it("uses the owning parent session in child-session viewer URLs", async () => {
    bindSessionToAnchor("parent", anchorChild);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });
    appendAlias({
      aliasType: "opencode.subsession",
      aliasValue: "child",
      anchorId: anchorChild,
    });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        ["pr", "create", "--title", "x", "--body", "body"],
        "child",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0]).toMatchObject({ bin: "gh" });
      expect(execCalls[0].args).toEqual([
        "pr",
        "create",
        "--title",
        "x",
        "--body",
        `body\n${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorChild}/${triggerId}`)}`,
      ]);
    });
  });

  it("injects into PR review-comment reply bodies", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        [
          "api",
          "repos/{owner}/{repo}/pulls/53/comments/123/replies",
          "--method",
          "POST",
          "-f",
          "body=Done",
        ],
        "parent",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0].args.at(-1)).toBe(
        `body=Done\n${formatThorContextFooter(`https://thor.example.com/runner/v/${anchorParent}/${triggerId}`)}`,
      );
    });
  });

  it("denies gh body-file content creation shapes", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const pr = await postGh(url, ["pr", "create", "--title", "x", "-F", "body.md"], "parent");
      expect(pr.response.status).toBe(400);
      expect(pr.body.stderr).toContain("gh pr create");

      const comment = await postGh(
        url,
        ["pr", "comment", "123", "--body-file", "body.md"],
        "parent",
      );
      expect(comment.response.status).toBe(400);
      expect(comment.body.stderr).toContain("gh pr comment");

      const issue = await postGh(
        url,
        ["issue", "comment", "42", "--body-file", "body.md"],
        "parent",
      );
      expect(issue.response.status).toBe(400);
      expect(issue.body.stderr).toContain("gh issue comment");
      expect(execCalls).toHaveLength(0);
    });
  });

  it("fails closed for duplicate mutable body fields", async () => {
    bindSessionToAnchor("parent", anchorParent);
    appendSessionEvent("parent", { type: "trigger_start", triggerId });

    await withServer(async (url) => {
      const comment = await postGh(
        url,
        ["pr", "comment", "123", "--body", "traced", "--body", "untraced"],
        "parent",
      );
      expect(comment.response.status).toBe(400);
      expect(comment.body.stderr).toContain("multiple --body values");

      const issue = await postGh(
        url,
        ["issue", "comment", "42", "--body", "traced", "--body", "untraced"],
        "parent",
      );
      expect(issue.response.status).toBe(400);
      expect(issue.body.stderr).toContain("multiple --body values");

      const reply = await postGh(
        url,
        [
          "api",
          "repos/{owner}/{repo}/pulls/53/comments/123/replies",
          "--method",
          "POST",
          "-f",
          "body=traced",
          "--raw-field",
          "body=untraced",
        ],
        "parent",
      );
      expect(reply.response.status).toBe(400);
      expect(reply.body.stderr).toContain("gh api");
      expect(execCalls).toHaveLength(0);
    });
  });
});
