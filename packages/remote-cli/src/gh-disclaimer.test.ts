import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { normalize as normalizePosix } from "node:path/posix";
import { appendAlias, appendSessionEvent } from "@thor/common";

vi.hoisted(() => {
  process.env.WORKLOG_DIR = "/tmp/thor-remote-cli-gh-test/worklog";
  process.env.RUNNER_BASE_URL = "https://thor.example.com";
});

const execCalls = vi.hoisted(() => [] as Array<{ bin: string; args: string[]; cwd: string }>);

vi.mock("./exec.js", () => ({
  execCommand: vi.fn(async (bin: string, args: string[], cwd: string) => {
    execCalls.push({ bin, args, cwd });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }),
  execCommandStream: vi.fn(),
}));

import { createRemoteCliApp } from "./index.js";

const worklogRoot = "/tmp/thor-remote-cli-gh-test";
const cwd = "/workspace/worktrees/acme/feat/test";
const triggerId = "00000000-0000-4000-8000-000000000201";
const secondTriggerId = "00000000-0000-4000-8000-000000000202";

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const remoteCli = createRemoteCliApp();
  const server: Server = createServer(remoteCli.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await remoteCli.close();
  }
}

async function postGh(url: string, args: string[], sessionId?: string) {
  const response = await fetch(`${url}/exec/gh`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sessionId ? { "x-thor-session-id": sessionId } : {}) },
    body: JSON.stringify({ args, cwd }),
  });
  return { response, body: (await response.json()) as { stdout: string; stderr: string; exitCode: number } };
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
  it("fails closed without a Thor session id", async () => {
    await withServer(async (url) => {
      const { response, body } = await postGh(url, ["pr", "comment", "123", "--body", "note"]);
      expect(response.status).toBe(400);
      expect(body.stderr).toContain("missing Thor session id");
      expect(execCalls).toHaveLength(0);
    });
  });

  it("fails closed when the session has no single active trigger", async () => {
    expect(appendSessionEvent("ambiguous", { type: "trigger_start", triggerId })).toEqual({ ok: true });
    expect(appendSessionEvent("ambiguous", { type: "trigger_start", triggerId: secondTriggerId })).toEqual({ ok: true });

    await withServer(async (url) => {
      const missing = await postGh(url, ["pr", "comment", "123", "--body", "note"], "missing");
      expect(missing.response.status).toBe(400);
      expect(missing.body.stderr).toContain("(none)");

      const ambiguous = await postGh(url, ["pr", "comment", "123", "--body", "note"], "ambiguous");
      expect(ambiguous.response.status).toBe(400);
      expect(ambiguous.body.stderr).toContain("(ambiguous)");
      expect(execCalls).toHaveLength(0);
    });
  });

  it("uses the owning parent session in child-session viewer URLs", async () => {
    expect(appendSessionEvent("parent", { type: "trigger_start", triggerId })).toEqual({ ok: true });
    expect(appendAlias({ aliasType: "session.parent", aliasValue: "child", sessionId: "parent" })).toEqual({ ok: true });

    await withServer(async (url) => {
      const { response } = await postGh(url, ["pr", "create", "--title", "x", "--body", "body"], "child");
      expect(response.status).toBe(200);
      expect(execCalls[0]).toMatchObject({ bin: "gh" });
      expect(execCalls[0].args).toEqual([
        "pr",
        "create",
        "--title",
        "x",
        "--body",
        `body\n\n---\n[View Thor trigger](https://thor.example.com/runner/v/parent/${triggerId})`,
      ]);
    });
  });

  it("injects into PR review-comment reply bodies", async () => {
    expect(appendSessionEvent("parent", { type: "trigger_start", triggerId })).toEqual({ ok: true });

    await withServer(async (url) => {
      const { response } = await postGh(
        url,
        ["api", "repos/{owner}/{repo}/pulls/53/comments/123/replies", "--method", "POST", "-f", "body=Done"],
        "parent",
      );
      expect(response.status).toBe(200);
      expect(execCalls[0].args.at(-1)).toBe(
        `body=Done\n\n---\n[View Thor trigger](https://thor.example.com/runner/v/parent/${triggerId})`,
      );
    });
  });

  it("denies gh body-file content creation shapes", async () => {
    expect(appendSessionEvent("parent", { type: "trigger_start", triggerId })).toEqual({ ok: true });

    await withServer(async (url) => {
      const pr = await postGh(url, ["pr", "create", "--title", "x", "-F", "body.md"], "parent");
      expect(pr.response.status).toBe(400);
      expect(pr.body.stderr).toContain("gh pr create");

      const comment = await postGh(url, ["pr", "comment", "123", "--body-file", "body.md"], "parent");
      expect(comment.response.status).toBe(400);
      expect(comment.body.stderr).toContain("gh pr comment");
      expect(execCalls).toHaveLength(0);
    });
  });
});
