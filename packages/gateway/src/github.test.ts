import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import type { EventQueue } from "./queue.js";

function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function mockSlackClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as WebClient;
}

async function withServer<T>(
  fetchImpl: typeof fetch,
  run: (baseUrl: string, queue: EventQueue) => Promise<T>,
): Promise<T> {
  const queueDir = mkdtempSync(join(tmpdir(), "gateway-github-test-"));
  const { app, queue } = createGatewayApp({
    signingSecret: "signing-secret",
    slack: mockSlackClient(),
    runnerUrl: "http://runner.test",
    fetchImpl,
    queueDir,
    disableQueueInterval: true,
    slackActiveDelayMs: 0,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine server address");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`, queue);
  } finally {
    queue.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(queueDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("github events", () => {
  it("accepts a pull_request event and correlates by branch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "pull_request",
        branch: "feat/dark-mode",
        repository: "acme/acme-project",
        payload: {
          action: "opened",
          number: 42,
          pull_request: {
            title: "Add dark mode",
            html_url: "https://github.com/acme/acme-project/pull/42",
            head: { ref: "feat/dark-mode", sha: "abc123" },
            base: { ref: "main" },
          },
          repository: { full_name: "acme/acme-project" },
          sender: { login: "johndoe" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:feat/dark-mode");
      expect(triggerBody.prompt).toContain("pull_request");
      expect(triggerBody.prompt).toContain("Add dark mode");
    });
  });

  it("accepts a pull_request_review event and correlates by branch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "pull_request_review",
        branch: "feat/dark-mode",
        repository: "acme/acme-project",
        payload: {
          action: "submitted",
          review: {
            state: "approved",
            body: "Looks good!",
            user: { login: "reviewer" },
          },
          pull_request: {
            number: 42,
            title: "Add dark mode",
            head: { ref: "feat/dark-mode", sha: "abc123" },
            base: { ref: "main" },
          },
          repository: { full_name: "acme/acme-project" },
          sender: { login: "reviewer" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:feat/dark-mode");
      expect(triggerBody.prompt).toContain("pull_request_review");
      expect(triggerBody.prompt).toContain("approved");
    });
  });

  it("accepts a pull_request_review_comment event and correlates by branch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "pull_request_review_comment",
        branch: "feat/dark-mode",
        repository: "acme/acme-project",
        payload: {
          action: "created",
          comment: {
            body: "This needs a nil check",
            path: "src/theme.ts",
            line: 42,
            user: { login: "reviewer" },
          },
          pull_request: {
            number: 42,
            title: "Add dark mode",
            head: { ref: "feat/dark-mode", sha: "abc123" },
            base: { ref: "main" },
          },
          repository: { full_name: "acme/acme-project" },
          sender: { login: "reviewer" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:feat/dark-mode");
      expect(triggerBody.prompt).toContain("pull_request_review_comment");
      expect(triggerBody.prompt).toContain("nil check");
    });
  });

  it("accepts a push event and correlates by branch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "push",
        branch: "main",
        repository: "acme/acme-project",
        payload: {
          ref: "refs/heads/main",
          after: "deadbeef1234",
          commits: [{ id: "deadbeef1234", message: "fix typo", author: { name: "dev" } }],
          repository: { full_name: "acme/acme-project" },
          sender: { login: "dev" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:main");
    });
  });

  it("accepts an issue_comment event on a PR with branch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "issue_comment",
        branch: "feat/dark-mode",
        repository: "acme/acme-project",
        payload: {
          action: "created",
          issue: {
            number: 42,
            title: "Add dark mode",
            pull_request: { url: "https://api.github.com/repos/acme/acme-project/pulls/42" },
          },
          comment: { body: "LGTM!", user: { login: "reviewer" } },
          repository: { full_name: "acme/acme-project" },
          sender: { login: "reviewer" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:feat/dark-mode");
      expect(triggerBody.prompt).toContain("issue_comment");
      expect(triggerBody.prompt).toContain("LGTM!");
    });
  });

  it("PR and push to the same branch share a correlation key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const prBody = JSON.stringify({
        event: "pull_request",
        branch: "feat/login",
        repository: "acme/acme-project",
        payload: {
          action: "opened",
          number: 5,
          pull_request: { head: { ref: "feat/login" } },
          repository: { full_name: "acme/acme-project" },
        },
      });

      const pushBody = JSON.stringify({
        event: "push",
        branch: "feat/login",
        repository: "acme/acme-project",
        payload: {
          ref: "refs/heads/feat/login",
          repository: { full_name: "acme/acme-project" },
        },
      });

      await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: prBody,
      });
      await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pushBody,
      });

      await queue.flush();

      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of triggerCalls) {
        const triggerBody = JSON.parse(String(call[1]?.body));
        expect(triggerBody.correlationKey).toBe("git:branch:acme/acme-project:feat/login");
      }
    });
  });

  it("ignores unsupported event types", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        event: "issues",
        branch: "main",
        repository: "acme/acme-project",
        payload: {
          action: "opened",
          issue: { number: 10 },
          repository: { full_name: "acme/acme-project" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores events missing branch field", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        event: "pull_request",
        payload: {
          action: "opened",
          number: 1,
          pull_request: { head: { ref: "feat/test" } },
          repository: { full_name: "acme/acme-project" },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores requests with no body", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("preserves extra fields in passthrough payload", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        event: "pull_request",
        branch: "feat/test",
        repository: "acme/acme-project",
        payload: {
          action: "opened",
          number: 1,
          pull_request: {
            title: "Test",
            head: { ref: "feat/test" },
            diff_url: "https://github.com/acme/acme-project/pull/1.diff",
            custom_field: "preserved",
          },
          repository: { full_name: "acme/acme-project" },
          sender: { login: "dev" },
          installation: { id: 12345 },
        },
      });

      const response = await fetch(`${baseUrl}/github/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(200);
      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledOnce();
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.prompt).toContain("installation");
      expect(triggerBody.prompt).toContain("custom_field");
    });
  });
});
