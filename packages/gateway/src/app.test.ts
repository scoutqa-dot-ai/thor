import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigLoader, WorkspaceConfig } from "@thor/common";
import { createGatewayApp, type GatewayAppConfig } from "./app.js";
import type { EventQueue } from "./queue.js";

/** Create a fake ConfigLoader from channel IDs and channel→repo map for tests. */
function fakeConfigLoader(
  channelIds: string[],
  channelRepoEntries?: [string, string][],
): ConfigLoader {
  const repos: Record<string, { channels: string[] }> = {};
  // Build a single repo entry per channel (or use channelRepoEntries mapping)
  if (channelRepoEntries) {
    for (const [ch, repo] of channelRepoEntries) {
      if (!repos[repo]) repos[repo] = { channels: [] };
      repos[repo].channels.push(ch);
    }
  } else {
    repos["test-repo"] = { channels: channelIds };
  }
  const config: WorkspaceConfig = { repos };
  const loader = (() => config) as ConfigLoader;
  loader.invalidate = () => {};
  return loader;
}

let mockHasSlackReply = false;
let mappedRepos = new Set<string>(["test-repo", "thor"]);
let notesKeys = new Set<string>();
vi.mock("@thor/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thor/common")>();
  return {
    ...actual,
    resolveRepoDirectory: (repoName: string) =>
      mappedRepos.has(repoName) ? `/workspace/repos/${repoName}` : undefined,
    hasSlackReply: () => mockHasSlackReply,
    findNotesFile: (correlationKey: string) =>
      notesKeys.has(correlationKey) ? `/workspace/worklog/test/${correlationKey}.md` : undefined,
  };
});

function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function signGitHub(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
}

function checkSuiteWebhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "completed",
    installation: { id: 126669985 },
    repository: { full_name: "scoutqa-dot-ai/thor" },
    sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    check_suite: {
      head_sha: "abc123def456",
      head_branch: "feature/refactor",
      conclusion: "success",
      status: "completed",
      updated_at: "2026-04-24T12:00:00Z",
      pull_requests: [
        {
          number: 42,
          head: {
            ref: "feature/refactor",
            sha: "abc123def456",
            repo: { full_name: "scoutqa-dot-ai/thor" },
          },
          base: { ref: "main", repo: { full_name: "scoutqa-dot-ai/thor" } },
        },
      ],
      ...overrides,
    },
  });
}

function readQueuedEvents(queueDir: string, subdir?: string): Array<Record<string, unknown>> {
  const dir = subdir ? join(queueDir, subdir) : queueDir;
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record<string, unknown>);
}

function readInboundWebhookHistoryEntries(worklogDir: string): Array<Record<string, unknown>> {
  return readJsonlStreamEntries(worklogDir, "inbound-webhook-history");
}

function readGitHubIngestedEntries(worklogDir: string): Array<Record<string, unknown>> {
  return readJsonlStreamEntries(worklogDir, "github-webhook-ingested");
}

function readGitHubIgnoredEntries(worklogDir: string): Array<Record<string, unknown>> {
  return readJsonlStreamEntries(worklogDir, "github-webhook-ignored");
}

function readJsonlStreamEntries(
  worklogDir: string,
  stream: string,
): Array<Record<string, unknown>> {
  try {
    const dayDir = readdirSync(worklogDir).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
    if (!dayDir) return [];
    const historyPath = join(worklogDir, dayDir, "jsonl", `${stream}.jsonl`);
    const content = readFileSync(historyPath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function withWorklogDir<T>(run: (worklogDir: string) => Promise<T>): Promise<T> {
  const worklogDir = mkdtempSync(join(tmpdir(), "gateway-worklog-test-"));
  const prevDir = process.env.WORKLOG_DIR;
  const prevEnabled = process.env.WORKLOG_ENABLED;
  process.env.WORKLOG_DIR = worklogDir;
  process.env.WORKLOG_ENABLED = "true";

  try {
    return await run(worklogDir);
  } finally {
    if (prevDir === undefined) {
      delete process.env.WORKLOG_DIR;
    } else {
      process.env.WORKLOG_DIR = prevDir;
    }

    if (prevEnabled === undefined) {
      delete process.env.WORKLOG_ENABLED;
    } else {
      process.env.WORKLOG_ENABLED = prevEnabled;
    }

    rmSync(worklogDir, { recursive: true, force: true });
  }
}

async function withServer<T>(
  fetchImpl: typeof fetch,
  run: (baseUrl: string, queue: EventQueue, queueDir: string) => Promise<T>,
  extraConfig?: Partial<GatewayAppConfig>,
): Promise<T> {
  const queueDir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const { app, queue } = createGatewayApp({
    signingSecret: "signing-secret",
    slackMcpUrl: "http://slack-mcp.test",
    slackBotUserId: "U0BOTEXAMPLE",
    runnerUrl: "http://runner.test",
    fetchImpl,
    queueDir,
    disableQueueInterval: true,
    shortDelayMs: 0,
    longDelayMs: 0,
    getConfig: fakeConfigLoader(["C123"], [["C123", "test-repo"]]),
    ...extraConfig,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine server address");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`, queue, queueDir);
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
  mockHasSlackReply = false;
  mappedRepos = new Set(["test-repo", "thor"]);
  notesKeys = new Set();
});

describe("gateway", () => {
  it("returns filtered Codex status from /health", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "gateway-auth-"));
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ openai: { access: "token-123" } }));

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "runner" }), { status: 200 });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        return new Response(
          JSON.stringify({
            plan_type: "prolite",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 1,
                limit_window_seconds: 18000,
                reset_after_seconds: 16117,
                reset_at: 1776339408,
              },
              secondary_window: {
                used_percent: 43,
                limit_window_seconds: 604800,
                reset_after_seconds: 35558,
                reset_at: 1776358849,
              },
            },
            additional_rate_limits: [
              {
                limit_name: "GPT-5.3-Codex-Spark",
                metered_feature: "codex_bengalfox",
                rate_limit: {
                  primary_window: {
                    used_percent: 0,
                    limit_window_seconds: 18000,
                    reset_after_seconds: 18000,
                    reset_at: 1776341291,
                  },
                },
              },
            ],
            nested: { raw: true },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/health`);

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            status: "ok",
            service: "gateway",
            runnerUrl: "http://runner.test",
            configured: true,
            queue: {
              status: "ok",
              pendingCount: 0,
              staleThresholdMs: 900000,
              staleEventCount: 0,
            },
            services: {
              runner: { status: "ok", service: "runner" },
              "slack-mcp": { status: "ok", service: "slack-mcp" },
              "remote-cli": { status: "ok", service: "remote-cli" },
            },
            codex: {
              status: "ok",
              authenticated: true,
              reachable: true,
              planType: "prolite",
              rateLimit: {
                allowed: true,
                limitReached: false,
                windows: [
                  {
                    name: "primary",
                    usedPercent: 1,
                    limitWindowSeconds: 18000,
                    resetAfterSeconds: 16117,
                    resetAt: "2026-04-16T11:36:48.000Z",
                  },
                  {
                    name: "secondary",
                    usedPercent: 43,
                    limitWindowSeconds: 604800,
                    resetAfterSeconds: 35558,
                    resetAt: "2026-04-16T17:00:49.000Z",
                  },
                  {
                    name: "primary",
                    usedPercent: 0,
                    limitWindowSeconds: 18000,
                    resetAfterSeconds: 18000,
                    resetAt: "2026-04-16T12:08:11.000Z",
                    limitName: "GPT-5.3-Codex-Spark",
                    meteredFeature: "codex_bengalfox",
                  },
                ],
              },
            },
          });
        },
        { openaiAuthPath: authPath },
      );
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("does not expose raw Codex usage payload when auth is missing", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "gateway-auth-"));
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({}));

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "runner" }), { status: 200 });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/health`);

          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            status: "ok",
            queue: {
              status: "ok",
              pendingCount: 0,
              staleThresholdMs: 900000,
              staleEventCount: 0,
            },
            codex: {
              status: "no_auth",
              authenticated: false,
              reachable: false,
              error: "missing access token",
            },
          });
          expect(fetchImpl).not.toHaveBeenCalledWith(
            "https://chatgpt.com/backend-api/wham/usage",
            expect.anything(),
          );
        },
        { openaiAuthPath: authPath },
      );
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("returns 503 when queue has stale pending events", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "runner" }), { status: 200 });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const staleReceivedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      queue.enqueue({
        id: "stale-event",
        source: "cron",
        correlationKey: "cron:stale",
        payload: { prompt: "stale" },
        receivedAt: staleReceivedAt,
        sourceTs: Date.now(),
        readyAt: Date.now() + 60_000,
      });

      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "error",
        queue: {
          status: "error",
          pendingCount: 1,
          staleThresholdMs: 900000,
          staleEventCount: 1,
          oldestPendingReceivedAt: staleReceivedAt,
        },
      });
    });
  });

  it("keeps HTTP 200 when dependencies fail but queue is not stale", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "error", error: "runner down" }), {
          status: 503,
        });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await withServer(fetchImpl, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "error",
        queue: {
          status: "ok",
          pendingCount: 0,
          staleThresholdMs: 900000,
          staleEventCount: 0,
        },
        services: {
          runner: {
            status: "error",
            error: "HTTP 503",
          },
        },
      });
    });
  });

  it("returns 503 when queue snapshot cannot be read", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "runner" }), { status: 200 });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await withServer(fetchImpl, async (baseUrl, _queue, queueDir) => {
      rmSync(queueDir, { recursive: true, force: true });

      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "error",
        queue: {
          status: "error",
          pendingCount: 0,
          staleThresholdMs: 900000,
          staleEventCount: 0,
          error: expect.stringContaining("queue snapshot failed:"),
        },
      });
    });
  });

  it("preserves receivedAt when GitHub pending-branch events are rerouted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "http://runner.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "runner" }), { status: 200 });
      }
      if (url === "http://slack-mcp.test/health") {
        return new Response(JSON.stringify({ status: "ok", service: "slack-mcp" }), {
          status: 200,
        });
      }
      if (url === "http://remote-cli:3004/health") {
        return new Response(JSON.stringify({ status: "ok", service: "remote-cli" }), {
          status: 200,
        });
      }
      if (url.startsWith("http://remote-cli:3004/github/pr-head?")) {
        return new Response(
          JSON.stringify({ ref: "feature/refactor", headRepoFullName: "acme/thor" }),
          { status: 200 },
        );
      }
      if (url === "http://runner.test/trigger" && init?.method === "POST") {
        return new Response(JSON.stringify({ busy: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await withServer(
      fetchImpl,
      async (baseUrl, queue, queueDir) => {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 1 },
          repository: { full_name: "acme/thor" },
          sender: { id: 1001, login: "alice", type: "User" },
          issue: {
            number: 12,
            pull_request: { html_url: "https://github.com/acme/thor/pull/12" },
          },
          comment: {
            body: "@thor please review",
            html_url: "https://github.com/acme/thor/pull/12#issuecomment-1",
            created_at: "2026-04-24T11:00:00Z",
          },
        });

        const webhookResponse = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "github-secret"),
            "X-GitHub-Delivery": "delivery-reroute-stale",
            "X-GitHub-Event": "issue_comment",
          },
          body,
        });

        expect(webhookResponse.status).toBe(200);

        const queueFiles = readdirSync(queueDir).filter(
          (entry) => entry.endsWith(".json") && !entry.startsWith("."),
        );
        expect(queueFiles).toHaveLength(1);

        const queuedPath = join(queueDir, queueFiles[0]);
        const queuedEvent = JSON.parse(readFileSync(queuedPath, "utf8")) as Record<string, unknown>;
        const staleReceivedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        writeFileSync(
          queuedPath,
          JSON.stringify({
            ...queuedEvent,
            receivedAt: staleReceivedAt,
          }),
          "utf8",
        );

        await queue.flush();

        const queuedAfterReroute = readQueuedEvents(queueDir);
        expect(queuedAfterReroute).toHaveLength(1);
        expect(queuedAfterReroute[0]).toMatchObject({
          id: "delivery-reroute-stale:resolved",
          correlationKey: "git:branch:thor:feature/refactor",
          receivedAt: staleReceivedAt,
        });

        const healthResponse = await fetch(`${baseUrl}/health`);
        expect(healthResponse.status).toBe(503);
        expect(await healthResponse.json()).toMatchObject({
          status: "error",
          queue: {
            status: "error",
            pendingCount: 1,
            staleEventCount: 1,
            oldestPendingReceivedAt: staleReceivedAt,
          },
        });
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
      },
    );
  });

  it("returns a placeholder response for the configured redirect URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/slack/redirect?code=test-code&state=test-state`);

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: "Slack OAuth redirect is configured but not implemented yet.",
        code: "test-code",
        state: "test-state",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("responds to Slack URL verification", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({ type: "url_verification", challenge: "challenge-token" });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;
      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "challenge-token" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("archives Slack valid payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(fetchImpl, async (baseUrl) => {
        const body = JSON.stringify({ type: "url_verification", challenge: "challenge-token" });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
            "X-Slack-Request-Id": "slack-req-1",
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ challenge: "challenge-token" });

        const entries = readInboundWebhookHistoryEntries(worklogDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          route: "/slack/events",
          provider: "slack",
          signatureVerified: true,
          parseStatus: "url_verification",
          requestId: "slack-req-1",
          eventType: "url_verification",
          rawBodyUtf8: body,
          rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
        });
      });
    });
  });

  it("archives Slack invalid signatures and returns 401", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(fetchImpl, async (baseUrl) => {
        const body = JSON.stringify({ type: "event_callback", event_id: "EvBadSig", event: {} });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "wrong-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(401);

        const entries = readInboundWebhookHistoryEntries(worklogDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          route: "/slack/events",
          provider: "slack",
          signatureVerified: false,
          parseStatus: "not_parsed",
          reason: "signature_invalid",
          rawBodyUtf8: body,
          rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
        });
      });
    });
  });

  it("preserves raw Slack webhook handling on trailing-slash route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(fetchImpl, async (baseUrl) => {
        const body = JSON.stringify({ type: "event_callback", event_id: "EvSlash", event: {} });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "wrong-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(401);

        const entries = readInboundWebhookHistoryEntries(worklogDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          route: "/slack/events",
          provider: "slack",
          signatureVerified: false,
          reason: "signature_invalid",
          rawBodyUtf8: body,
        });
      });
    });
  });

  it("archives Slack malformed JSON payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(fetchImpl, async (baseUrl) => {
        const body = '{"type":"event_callback"';
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, ignored: true });

        const entries = readInboundWebhookHistoryEntries(worklogDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          route: "/slack/events",
          provider: "slack",
          signatureVerified: true,
          parseStatus: "json_invalid",
          reason: "json_parse_error",
          rawBodyUtf8: body,
          rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
        });
      });
    });
  });

  it("archives accepted GitHub webhook payloads to ingested stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            installation: { id: 1 },
            repository: { full_name: "acme/thor" },
            sender: { id: 1001, login: "alice", type: "User" },
            issue: {
              number: 12,
              pull_request: { html_url: "https://github.com/acme/thor/pull/12" },
            },
            comment: {
              body: "@thor please check",
              html_url: "https://github.com/acme/thor/issues/12#issuecomment-1",
              created_at: "2026-04-24T11:00:00Z",
            },
          });

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-archive-ok",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true });

          const entries = readGitHubIngestedEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            route: "/github/webhook",
            provider: "github",
            signatureVerified: true,
            parseStatus: "schema_valid",
            requestId: "delivery-archive-ok",
            eventType: "issue_comment",
            action: "created",
            reason: "accepted",
            rawBodyUtf8: body,
            rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
          });
          expect(readGitHubIgnoredEntries(worklogDir)).toHaveLength(0);
          expect(readInboundWebhookHistoryEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("archives GitHub invalid signatures and returns 401", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            repository: { full_name: "acme/thor" },
          });

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "wrong-secret"),
              "X-GitHub-Delivery": "delivery-archive-bad-sig",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(401);

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            route: "/github/webhook",
            provider: "github",
            signatureVerified: false,
            parseStatus: "not_parsed",
            requestId: "delivery-archive-bad-sig",
            reason: "signature_invalid",
            rawBodyUtf8: body,
            rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
          });
          expect(readGitHubIngestedEntries(worklogDir)).toHaveLength(0);
          expect(readInboundWebhookHistoryEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("preserves raw GitHub webhook handling on trailing-slash route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            repository: { full_name: "acme/thor" },
          });

          const response = await fetch(`${baseUrl}/github/webhook/`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "wrong-secret"),
              "X-GitHub-Delivery": "delivery-trailing-slash-bad-sig",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(401);

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            route: "/github/webhook",
            provider: "github",
            signatureVerified: false,
            requestId: "delivery-trailing-slash-bad-sig",
            reason: "signature_invalid",
            rawBodyUtf8: body,
          });
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("archives malformed GitHub webhook JSON payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = '{"action":"created"';

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-archive-bad-json",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            route: "/github/webhook",
            provider: "github",
            signatureVerified: true,
            parseStatus: "json_invalid",
            requestId: "delivery-archive-bad-json",
            reason: "json_parse_error",
            rawBodyUtf8: body,
            rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
          });
          expect(readGitHubIngestedEntries(worklogDir)).toHaveLength(0);
          expect(readInboundWebhookHistoryEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("archives schema-invalid GitHub webhook payloads with schema_validation_failed reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            repository: { full_name: "acme/thor" },
          });

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-archive-schema-invalid",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            requestId: "delivery-archive-schema-invalid",
            eventType: "issue_comment",
            parseStatus: "schema_invalid",
            reason: "schema_validation_failed",
          });
          expect(readGitHubIngestedEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("archives repo_not_mapped GitHub outcomes to ignored stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            installation: { id: 1 },
            repository: { full_name: "acme/not-mapped" },
            sender: { id: 1001, login: "alice", type: "User" },
            issue: {
              number: 12,
              pull_request: { html_url: "https://github.com/acme/not-mapped/pull/12" },
            },
            comment: {
              body: "@thor please check",
              html_url: "https://github.com/acme/not-mapped/issues/12#issuecomment-1",
              created_at: "2026-04-24T11:00:00Z",
            },
          });

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-repo-not-mapped",
              "X-GitHub-Event": "issue_comment",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            requestId: "delivery-repo-not-mapped",
            eventType: "issue_comment",
            reason: "repo_not_mapped",
            parseStatus: "schema_valid",
          });
          expect(readGitHubIngestedEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("archives normalization-level ignored GitHub outcomes to ignored stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl) => {
          const body = JSON.stringify({
            action: "created",
            installation: { id: 126669985 },
            repository: { full_name: "scoutqa-dot-ai/thor" },
            sender: { id: 1001, login: "alice", type: "User" },
            pull_request: {
              number: 42,
              user: { id: 1001, login: "alice" },
              head: { ref: "feature/refactor", repo: { full_name: "scoutqa-dot-ai/thor" } },
              base: { repo: { full_name: "scoutqa-dot-ai/thor" } },
            },
            comment: {
              body: "@codex review",
              html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r9",
              created_at: "2026-04-24T11:00:00Z",
            },
          });

          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-normalized-ignored",
              "X-GitHub-Event": "pull_request_review_comment",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });

          const entries = readGitHubIgnoredEntries(worklogDir);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            requestId: "delivery-normalized-ignored",
            eventType: "pull_request_review_comment",
            reason: "non_mention_comment",
            parseStatus: "schema_valid",
          });
          expect(readGitHubIngestedEntries(worklogDir)).toHaveLength(0);
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("enqueues valid GitHub webhook with branch correlation and mention delay", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl, _queue, queueDir) => {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 126669985 },
          repository: { full_name: "scoutqa-dot-ai/thor" },
          sender: { id: 1001, login: "alice", type: "User" },
          pull_request: {
            number: 42,
            user: { id: 1001, login: "alice" },
            head: { ref: "feature/refactor", repo: { full_name: "scoutqa-dot-ai/thor" } },
            base: { repo: { full_name: "scoutqa-dot-ai/thor" } },
          },
          comment: {
            body: "Please check this @thor",
            html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r1",
            created_at: "2026-04-24T11:00:00Z",
          },
        });

        const response = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "github-secret"),
            "X-GitHub-Delivery": "delivery-1",
            "X-GitHub-Event": "pull_request_review_comment",
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        const queued = readQueuedEvents(queueDir);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          id: "delivery-1",
          source: "github",
          correlationKey: "git:branch:thor:feature/refactor",
          delayMs: 3000,
          interrupt: true,
          payload: {
            action: "created",
            repository: { full_name: "scoutqa-dot-ai/thor" },
            pull_request: {
              number: 42,
              head: { ref: "feature/refactor" },
            },
          },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
        githubAppBotId: 7777,
      },
    );
  });

  it("enqueues check_suite events only when the branch has an existing notes-backed session", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const internalExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "49699333+thor[bot]@users.noreply.github.com\n",
        stderr: "",
        exitCode: 0,
      });

    await withWorklogDir(async (worklogDir) => {
      notesKeys.add("git:branch:thor:feature/refactor");

      await withServer(
        fetchImpl,
        async (baseUrl, _queue, queueDir) => {
          const body = checkSuiteWebhookBody();
          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-check-suite-ok",
              "X-GitHub-Event": "check_suite",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true });

          const queued = readQueuedEvents(queueDir);
          expect(queued).toHaveLength(1);
          expect(queued[0]).toMatchObject({
            id: "delivery-check-suite-ok",
            source: "github",
            correlationKey: "git:branch:thor:feature/refactor",
            delayMs: 0,
            interrupt: false,
            payload: {
              event_type: "check_suite",
              action: "completed",
              check_suite: {
                head_sha: "abc123def456",
                head_branch: "feature/refactor",
                conclusion: "success",
              },
            },
          });

          const ingested = readGitHubIngestedEntries(worklogDir);
          expect(ingested).toHaveLength(1);
          expect(ingested[0]).toMatchObject({
            reason: "accepted",
            eventType: "check_suite",
            metadata: { correlationKey: "git:branch:thor:feature/refactor" },
          });
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
          githubAppBotEmail: "49699333+thor[bot]@users.noreply.github.com",
          internalExec,
        },
      );
    });

    expect(internalExec).toHaveBeenCalledWith({
      bin: "git",
      args: ["cat-file", "-e", "abc123def456"],
      cwd: "/workspace/repos/thor",
    });
    expect(internalExec).toHaveBeenCalledWith({
      bin: "git",
      args: ["log", "-1", "--format=%ae", "abc123def456"],
      cwd: "/workspace/repos/thor",
    });
  });

  it.each([
    {
      gateReason: "sha_missing",
      execResults: [{ stdout: "", stderr: "missing", exitCode: 128 }],
    },
    {
      gateReason: "author_mismatch",
      execResults: [
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "alice@example.com\n", stderr: "", exitCode: 0 },
      ],
    },
    {
      gateReason: "exec_failed",
      execResults: [new Error("timeout")],
    },
  ])(
    "ignores check_suite events when the git gate returns $gateReason",
    async ({ gateReason, execResults }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const internalExec = vi.fn();
      for (const result of execResults) {
        if (result instanceof Error) {
          internalExec.mockRejectedValueOnce(result);
        } else {
          internalExec.mockResolvedValueOnce(result);
        }
      }

      await withWorklogDir(async (worklogDir) => {
        notesKeys.add("git:branch:thor:feature/refactor");

        await withServer(
          fetchImpl,
          async (baseUrl, _queue, queueDir) => {
            const body = checkSuiteWebhookBody();
            const response = await fetch(`${baseUrl}/github/webhook`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Hub-Signature-256": signGitHub(body, "github-secret"),
                "X-GitHub-Delivery": `delivery-check-suite-${gateReason}`,
                "X-GitHub-Event": "check_suite",
              },
              body,
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true, ignored: true });
            expect(readQueuedEvents(queueDir)).toHaveLength(0);

            const ignored = readGitHubIgnoredEntries(worklogDir);
            expect(ignored).toHaveLength(1);
            expect(ignored[0]).toMatchObject({
              reason: "check_suite_gate_failed",
              eventType: "check_suite",
              metadata: {
                headSha: "abc123def456",
                gateReason,
              },
            });
          },
          {
            githubWebhookSecret: "github-secret",
            githubMentionLogins: ["thor", "thor[bot]"],
            githubAppBotId: 7777,
            githubAppBotEmail: "49699333+thor[bot]@users.noreply.github.com",
            internalExec,
          },
        );
      });
    },
  );

  it("ignores check_suite events without an existing notes-backed session", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl, _queue, queueDir) => {
          const body = checkSuiteWebhookBody();
          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-check-suite-unresolved",
              "X-GitHub-Event": "check_suite",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });
          expect(readQueuedEvents(queueDir)).toHaveLength(0);

          const ignored = readGitHubIgnoredEntries(worklogDir);
          expect(ignored).toHaveLength(1);
          expect(ignored[0]).toMatchObject({
            reason: "correlation_key_unresolved",
            eventType: "check_suite",
            metadata: {
              rawKey: "git:branch:thor:feature/refactor",
              resolvedKey: "git:branch:thor:feature/refactor",
              headSha: "abc123def456",
            },
          });
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("ignores branchless check_suite events before pending branch resolution", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withWorklogDir(async (worklogDir) => {
      await withServer(
        fetchImpl,
        async (baseUrl, _queue, queueDir) => {
          const body = checkSuiteWebhookBody({ head_branch: null });
          const response = await fetch(`${baseUrl}/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Hub-Signature-256": signGitHub(body, "github-secret"),
              "X-GitHub-Delivery": "delivery-check-suite-branchless",
              "X-GitHub-Event": "check_suite",
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true, ignored: true });
          expect(readQueuedEvents(queueDir)).toHaveLength(0);

          const ignored = readGitHubIgnoredEntries(worklogDir);
          expect(ignored).toHaveLength(1);
          expect(ignored[0]).toMatchObject({
            reason: "check_suite_branch_missing",
            eventType: "check_suite",
            metadata: { headSha: "abc123def456" },
          });
        },
        {
          githubWebhookSecret: "github-secret",
          githubMentionLogins: ["thor", "thor[bot]"],
          githubAppBotId: 7777,
        },
      );
    });
  });

  it("returns 401 and does not enqueue for invalid GitHub signature", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl, _queue, queueDir) => {
        const body = JSON.stringify({ action: "created", repository: { full_name: "acme/thor" } });

        const response = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "wrong-secret"),
            "X-GitHub-Delivery": "delivery-bad-sig",
            "X-GitHub-Event": "pull_request_review_comment",
          },
          body,
        });

        expect(response.status).toBe(401);
        expect(readQueuedEvents(queueDir)).toHaveLength(0);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
        githubAppBotId: 7777,
      },
    );
  });

  it("ignores pure issue comments and does not enqueue", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl, _queue, queueDir) => {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 1 },
          repository: { full_name: "acme/thor" },
          sender: { id: 1001, login: "alice", type: "User" },
          issue: { number: 12, pull_request: null },
          comment: {
            body: "hello",
            html_url: "https://github.com/acme/thor/issues/12#issuecomment-1",
            created_at: "2026-04-24T11:00:00Z",
          },
        });

        const response = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "github-secret"),
            "X-GitHub-Delivery": "delivery-pure-issue",
            "X-GitHub-Event": "issue_comment",
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(readQueuedEvents(queueDir)).toHaveLength(0);
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
        githubAppBotId: 7777,
      },
    );
  });

  it("ignores PR comments that do not mention the configured app", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl, _queue, queueDir) => {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 126669985 },
          repository: { full_name: "scoutqa-dot-ai/thor" },
          sender: { id: 1001, login: "alice", type: "User" },
          pull_request: {
            number: 42,
            user: { id: 1001, login: "alice" },
            head: { ref: "feature/refactor", repo: { full_name: "scoutqa-dot-ai/thor" } },
            base: { repo: { full_name: "scoutqa-dot-ai/thor" } },
          },
          comment: {
            body: "@codex review",
            html_url: "https://github.com/scoutqa-dot-ai/thor/pull/42#discussion_r9",
            created_at: "2026-04-24T11:00:00Z",
          },
        });

        const response = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "github-secret"),
            "X-GitHub-Delivery": "delivery-non-mention",
            "X-GitHub-Event": "pull_request_review_comment",
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(readQueuedEvents(queueDir)).toHaveLength(0);
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
        githubAppBotId: 7777,
      },
    );
  });

  it("enqueues issue_comment PR events with pending branch-resolve correlation key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl, _queue, queueDir) => {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 1 },
          repository: { full_name: "acme/thor" },
          sender: { id: 1001, login: "alice", type: "User" },
          issue: {
            number: 12,
            pull_request: { html_url: "https://github.com/acme/thor/pull/12" },
          },
          comment: {
            body: "@thor please review",
            html_url: "https://github.com/acme/thor/pull/12#issuecomment-1",
            created_at: "2026-04-24T11:00:00Z",
          },
        });

        const response = await fetch(`${baseUrl}/github/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signGitHub(body, "github-secret"),
            "X-GitHub-Delivery": "delivery-branch-pending",
            "X-GitHub-Event": "issue_comment",
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        const queued = readQueuedEvents(queueDir);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          id: "delivery-branch-pending",
          source: "github",
          correlationKey: "pending:branch-resolve:thor:12",
          delayMs: 3000,
          interrupt: true,
          payload: {
            action: "created",
            issue: { number: 12 },
          },
        });
      },
      {
        githubWebhookSecret: "github-secret",
        githubMentionLogins: ["thor", "thor[bot]"],
        githubAppBotId: 7777,
      },
    );
  });

  it("acknowledges subscribed non-app_mention events without triggering runner calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvReaction",
        team_id: "T123",
        event: {
          type: "reaction_added",
          user: "U123",
          reaction: "eyes",
          item: {
            type: "message",
            channel: "C123",
            ts: "1710000000.001",
          },
          event_ts: "1710000000.010",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        eventType: "reaction_added",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("accepts a signed app mention and fires a trigger to the runner (fire-and-forget)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // 1st call: POST /reaction to slack-mcp
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      // 2nd call: POST /trigger to runner
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev123",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@U999> investigate checkout errors",
          ts: "1710000000.001",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      // Reaction via slack-mcp
      const reactionCall = fetchImpl.mock.calls.find(
        (c) => c[0] === "http://slack-mcp.test/reaction",
      );
      expect(reactionCall).toBeDefined();
      const reactionBody = JSON.parse(String(reactionCall![1]?.body));
      expect(reactionBody).toEqual({
        channel: "C123",
        timestamp: "1710000000.001",
        reaction: "eyes",
      });

      // Runner trigger via fetchImpl
      const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
      expect(triggerCall).toBeDefined();
      const triggerBody = JSON.parse(String(triggerCall![1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      const promptJson = triggerBody.prompt.split("\n\n").slice(1).join("\n\n");
      const promptPayload = JSON.parse(promptJson);
      expect(promptPayload.type).toBe("app_mention");
      expect(promptPayload.channel).toBe("C123");
      expect(promptPayload.text).toContain("investigate checkout errors");
    });
  });

  it("ignores thread replies in unengaged threads (Thor has not replied)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    mockHasSlackReply = false;

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev456",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "can you also check staging?",
          ts: "1710000000.002",
          thread_ts: "1710000000.001",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });

      await queue.flush();

      // Not engaged — should not trigger
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("enqueues thread replies in engaged threads (Thor has replied before)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200 (fire-and-forget)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockHasSlackReply = true;

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "Ev456eng",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "can you also check staging?",
          ts: "1710000000.002",
          thread_ts: "1710000000.001",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      // Engaged — should trigger
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      expect(triggerBody.interrupt).toBe(false);
    });
  });

  it("ignores new channel messages (not in a thread) when not engaged", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    mockHasSlackReply = false;

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvNew",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "anyone know why staging is down?",
          ts: "1710000000.010",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });

      await queue.flush();

      // Not engaged — should not trigger
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores messages sent by our own bot user", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvSelf",
        team_id: "T123",
        event: {
          type: "message",
          user: "U0BOTEXAMPLE",
          text: "I am the bot",
          ts: "1710000000.020",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores app_mention from our own bot user", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvSelfMention",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U0BOTEXAMPLE",
          text: "<@U0BOTEXAMPLE> hello myself",
          ts: "1710000000.030",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("handles other bot messages in engaged threads like normal messages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockHasSlackReply = true;

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvBot",
        team_id: "T123",
        event: {
          type: "message",
          user: "U999",
          text: "deploy completed",
          ts: "1710000000.003",
          thread_ts: "1710000000.001",
          channel: "C123",
          bot_id: "B123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await queue.flush();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe("http://runner.test/trigger");
      const triggerBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(triggerBody.prompt).toContain("deploy completed");
      expect(triggerBody.prompt).toContain("B123");
    });
  });

  it("batches 3 rapid app_mention events into a single runner trigger with combined prompt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // Reaction calls to slack-mcp (3x)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      // POST /trigger → 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      // Fire 3 mentions in quick succession (same thread)
      for (const [i, text] of ["message 1", "message 2", "message 3"].entries()) {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: `Ev${i + 1}`,
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: `<@U999> ${text}`,
            ts: "1710000000.001",
            channel: "C123",
          },
        });

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });
        expect(response.status).toBe(200);
      }

      await queue.flush();

      // 3 reaction calls to slack-mcp
      const reactionCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://slack-mcp.test/reaction",
      );
      expect(reactionCalls).toHaveLength(3);

      // 1 runner trigger via fetchImpl — combined prompt with Slack context
      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls).toHaveLength(1);
      const triggerBody = JSON.parse(String(triggerCalls[0][1]?.body));
      expect(triggerBody.correlationKey).toBe("slack:thread:1710000000.001");
      const promptJson = triggerBody.prompt.split("\n\n").slice(1).join("\n\n");
      const promptPayloads = JSON.parse(promptJson);
      expect(promptPayloads).toHaveLength(3);
      expect(promptPayloads[0].text).toContain("message 1");
      expect(promptPayloads[2].text).toContain("message 3");
    });
  });

  it("app_mention fires immediately ignoring shortDelayMs (interrupt shouldn't wait)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    // Use a large shortDelayMs — mention should still fire immediately.
    await withServer(
      fetchImpl,
      async (baseUrl, queue) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvFast",
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U999> stop what you're doing",
            ts: "1710000000.001",
            channel: "C123",
          },
        });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });
        expect(response.status).toBe(200);

        await queue.flush();

        const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
        expect(triggerCall).toBeDefined();
        const triggerBody = JSON.parse(String(triggerCall![1]?.body));
        expect(triggerBody.interrupt).toBe(true);
      },
      { shortDelayMs: 60_000 },
    );
  });

  it("processes two messages sent at different times as separate triggers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await withServer(fetchImpl, async (baseUrl, queue) => {
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      function makeBody(eventId: string, text: string) {
        return JSON.stringify({
          type: "event_callback",
          event_id: eventId,
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: `<@U999> ${text}`,
            ts: "1710000000.001",
            channel: "C123",
          },
        });
      }

      // Send message 1 and flush
      const body1 = makeBody("Ev1", "message 1");
      await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body1, "signing-secret", timestamp),
        },
        body: body1,
      });
      await queue.flush();

      // Send message 2 and flush
      const body2 = makeBody("Ev2", "message 2");
      await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body2, "signing-secret", timestamp),
        },
        body: body2,
      });
      await queue.flush();

      // Both messages should have triggered the runner
      const triggerCalls = fetchImpl.mock.calls.filter(
        (c) => c[0] === "http://runner.test/trigger",
      );
      expect(triggerCalls).toHaveLength(2);

      expect(JSON.parse(String(triggerCalls[0][1]?.body))).toMatchObject({
        prompt: expect.stringContaining("message 1"),
      });
      expect(JSON.parse(String(triggerCalls[1][1]?.body))).toMatchObject({
        prompt: expect.stringContaining("message 2"),
      });
    });
  });

  it("ignores message events that duplicate an app_mention (contains bot mention)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDup",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "<@U0BOTEXAMPLE> check staging",
          ts: "1710000000.040",
          channel: "C123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores events from channels not in the allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvBlocked",
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U999> hello",
            ts: "1710000000.050",
            channel: "C_NOT_ALLOWED",
          },
        });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      { getConfig: fakeConfigLoader(["C_ALLOWED"]) },
    );
  });

  it("accepts events from channels in the allowlist", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(
      fetchImpl,
      async (baseUrl, queue) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvAllowed",
          team_id: "T123",
          event: {
            type: "app_mention",
            user: "U123",
            text: "<@U999> hello",
            ts: "1710000000.060",
            channel: "C_ALLOWED",
          },
        });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        await queue.flush();

        const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
        expect(triggerCall).toBeDefined();
      },
      { getConfig: fakeConfigLoader(["C_ALLOWED"], [["C_ALLOWED", "test-repo"]]) },
    );
  });

  it("ignores messages from channels not in the allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(
      fetchImpl,
      async (baseUrl) => {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: "EvMsgBlocked",
          team_id: "T123",
          event: {
            type: "message",
            user: "U123",
            text: "hello from blocked channel",
            ts: "1710000000.070",
            channel: "C_BLOCKED",
          },
        });
        const timestamp = `${Math.floor(Date.now() / 1000)}`;

        const response = await fetch(`${baseUrl}/slack/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": sign(body, "signing-secret", timestamp),
          },
          body,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, ignored: true });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
      { getConfig: fakeConfigLoader(["C_ALLOWED"]) },
    );
  });

  it("ignores direct messages (DM channels starting with D)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDM",
        team_id: "T123",
        event: {
          type: "message",
          user: "U123",
          text: "hey bot",
          ts: "1710000000.080",
          channel: "D0ABC123",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("ignores app_mention in DM channels", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: "EvDMMention",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@U999> help me",
          ts: "1710000000.090",
          channel: "D0XYZ789",
        },
      });
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ignored: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("accepts signed Slack interactivity payloads on the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, async (baseUrl) => {
      const payload = encodeURIComponent(
        JSON.stringify({
          type: "block_actions",
          user: { id: "U123" },
          actions: [{ action_id: "approve" }],
        }),
      );
      const body = `payload=${payload}`;
      const timestamp = `${Math.floor(Date.now() / 1000)}`;

      const response = await fetch(`${baseUrl}/slack/interactivity`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": sign(body, "signing-secret", timestamp),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        interactionType: "block_actions",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("resolves approval actions through remote-cli for current v2 button values", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 })))
      .mockResolvedValueOnce(new Response("ok"));

    await withServer(
      fetchImpl,
      async (baseUrl) => {
        const payloads = [
          {
            type: "block_actions",
            user: { id: "U123" },
            channel: { id: "C123" },
            message: { ts: "1710000000.001" },
            actions: [{ action_id: "approval_approve", value: "v2:act-1:slack" }],
          },
        ];

        for (const payloadData of payloads) {
          const payload = encodeURIComponent(JSON.stringify(payloadData));
          const body = `payload=${payload}`;
          const timestamp = `${Math.floor(Date.now() / 1000)}`;

          const response = await fetch(`${baseUrl}/slack/interactivity`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-Slack-Request-Timestamp": timestamp,
              "X-Slack-Signature": sign(body, "signing-secret", timestamp),
            },
            body,
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ok: true });
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      {
        remoteCliHost: "remote-cli.internal",
        remoteCliPort: 3010,
        internalSecret: "resolve-secret",
      },
    );

    const execCalls = fetchImpl.mock.calls.filter(
      ([url]) => typeof url === "string" && url === "http://remote-cli.internal:3010/exec/mcp",
    );
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-thor-internal-secret": "resolve-secret",
      },
      body: JSON.stringify({ args: ["resolve", "act-1", "approved", "U123"] }),
    });
  });
});
