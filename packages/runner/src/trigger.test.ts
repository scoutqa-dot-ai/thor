import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TextPart } from "@opencode-ai/sdk";
import { createRunnerApp, type RunnerAppOptions } from "./index.js";
import {
  appendAlias,
  appendCorrelationAliasForAnchor,
  appendSessionEvent,
  mintAnchor,
  resolveAnchorForCorrelationKey,
  sessionLogPath,
} from "@thor/common";

const worklogDir = "/tmp/thor-runner-trigger-test/worklog";
const originalEnv = vi.hoisted(() => {
  const sessionErrorGraceMs = process.env.SESSION_ERROR_GRACE_MS;
  process.env.WORKLOG_DIR = "/tmp/thor-runner-trigger-test/worklog";
  process.env.SESSION_ERROR_GRACE_MS = "20";
  return { sessionErrorGraceMs };
});
const sessionDir = "/workspace/repos/runner-trigger-test";
const memoryDir = "/tmp/thor-runner-trigger-test/memory";

class FakeSubscription implements AsyncIterable<Event> {
  private queue: Event[] = [];
  private waiters: Array<(value: IteratorResult<Event>) => void> = [];
  private closed = false;

  addSessionId(): void {}

  push(event: Event): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Event>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeEventBuses {
  subscriptions: FakeSubscription[] = [];

  async subscribe(): Promise<FakeSubscription> {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }

  latest(): FakeSubscription {
    const sub = this.subscriptions.at(-1);
    if (!sub) throw new Error("no subscription");
    return sub;
  }
}

function textEvent(sessionId: string, text: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        text,
      } as TextPart,
    },
  } as Event;
}

function idleEvent(sessionId: string): Event {
  return { type: "session.idle", properties: { sessionID: sessionId } } as Event;
}

function taskRunningEvent(sessionId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        callID: "call-task",
        tool: "task",
        state: { status: "running", input: { subagent_type: "general" } },
      },
    },
  } as unknown as Event;
}

function toolEvent(
  sessionId: string,
  tool: string,
  status: string,
  input: Record<string, unknown>,
  time: { start: number; end: number } = { start: 1000, end: 2500 },
  output?: string,
): Event {
  const state = { status, input, time, ...(output !== undefined ? { output } : {}) };
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        callID: `call-${tool}`,
        tool,
        state,
      },
    },
  } as unknown as Event;
}

function stepFinishEvent(sessionId: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: sessionId,
        messageID: `m-${sessionId}`,
        reason: "stop",
        cost: 0.0123,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
    },
  } as unknown as Event;
}

function statusEvent(sessionId: string): Event {
  return { type: "session.status", properties: { sessionID: sessionId, status: "busy" } } as Event;
}

function sessionErrorEvent(sessionId: string, message: string): Event {
  return {
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: { name: "ProviderError", data: { message } },
    },
  } as Event;
}

function createHarness(
  opts: {
    existingSessions?: Set<string>;
    busySessions?: Set<string>;
    children?: Array<{ id: string }>;
    onGet?: (sessionId: string) => Promise<void>;
    promptEvents?: (sessionId: string, sub: FakeSubscription) => Event[] | void;
    throwInSubscribe?: boolean;
  } = {},
) {
  const buses = new FakeEventBuses();
  const existingSessions = opts.existingSessions ?? new Set<string>();
  const busySessions = opts.busySessions ?? new Set<string>();
  const prompts: string[] = [];
  const aborts: string[] = [];
  const abortedPending = new Set<string>();
  let counter = 0;

  const client = {
    session: {
      create: async () => {
        const id = `session-${++counter}`;
        existingSessions.add(id);
        return { data: { id } };
      },
      get: async ({ path }: { path: { id: string } }) => {
        await opts.onGet?.(path.id);
        if (!existingSessions.has(path.id)) throw new Error("missing");
        return { data: { id: path.id } };
      },
      status: async () => ({
        data: Object.fromEntries([...busySessions].map((id) => [id, { type: "busy" }])),
      }),
      abort: async ({ path }: { path: { id: string } }) => {
        aborts.push(path.id);
        busySessions.delete(path.id);
        abortedPending.add(path.id);
        return { data: {} };
      },
      promptAsync: async ({
        path,
        body,
      }: {
        path: { id: string };
        body: { parts: Array<{ text: string }> };
      }) => {
        prompts.push(body.parts[0]?.text ?? "");
        const sub = buses.latest();
        queueMicrotask(() => {
          const events = opts.promptEvents
            ? opts.promptEvents(path.id, sub)
            : [textEvent(path.id, `ok ${path.id}`), idleEvent(path.id)];
          if (!events) return;
          for (const event of events) sub.push(event);
        });
        return { data: {} };
      },
      children: async () => ({ data: opts.children ?? [] }),
    },
  };

  const app = createRunnerApp({
    eventBuses: opts.throwInSubscribe
      ? ({
          subscribe: async () => {
            throw new Error("subscribe failed");
          },
        } as unknown as RunnerAppOptions["eventBuses"])
      : ({
          subscribe: async () => {
            const sub = await buses.subscribe();
            for (const id of abortedPending) {
              queueMicrotask(() => sub.push(idleEvent(id)));
              abortedPending.delete(id);
            }
            return sub;
          },
        } as unknown as RunnerAppOptions["eventBuses"]),
    memoryDir,
    createClient: () =>
      client as unknown as ReturnType<NonNullable<RunnerAppOptions["createClient"]>>,
    ensureOpencodeAvailable: async () => {},
    isOpencodeReachable: async () => true,
  });

  return { app, prompts, aborts, existingSessions, busySessions };
}

async function withServer<T>(
  app: ReturnType<typeof createRunnerApp>,
  fn: (url: string) => Promise<T>,
) {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function trigger(url: string, body: Record<string, unknown>) {
  const response = await fetch(`${url}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory: sessionDir, ...body }),
  });
  const text = await response.text();
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, events };
}

beforeEach(() => {
  process.env.WORKLOG_DIR = worklogDir;
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
});

afterEach(() => {
  if (originalEnv.sessionErrorGraceMs === undefined) delete process.env.SESSION_ERROR_GRACE_MS;
  else process.env.SESSION_ERROR_GRACE_MS = originalEnv.sessionErrorGraceMs;
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
});

function bindSessionToAnchor(sessionId: string, anchorId: string): void {
  const result = appendAlias({ aliasType: "opencode.session", aliasValue: sessionId, anchorId });
  if (!result.ok) throw result.error;
}

function readAliases(): Array<{ aliasType: string; aliasValue: string; anchorId: string }> {
  try {
    return readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Mint a busy-session fixture: anchor + opencode.session + slack.thread alias. */
function setupBusySession(slackThreadTs: string): string {
  const anchorId = mintAnchor();
  bindSessionToAnchor("busy-session", anchorId);
  const aliasResult = appendAlias({
    aliasType: "slack.thread_id",
    aliasValue: slackThreadTs,
    anchorId,
  });
  if (!aliasResult.ok) throw aliasResult.error;
  return anchorId;
}

describe("runner /trigger orchestration", () => {
  it("serves the Vouch-gated trigger viewer with 401, 404, and rendered status", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000301";
    const anchorId = mintAnchor();
    bindSessionToAnchor("viewer-session", anchorId);
    expect(appendSessionEvent("viewer-session", { type: "trigger_start", triggerId })).toEqual({
      ok: true,
    });
    expect(
      appendSessionEvent("viewer-session", { type: "trigger_end", triggerId, status: "completed" }),
    ).toEqual({ ok: true });

    await withServer(h.app, async (url) => {
      const unauthorized = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.text()).toContain("Unauthorized");

      const missing = await fetch(
        `${url}/runner/v/${anchorId}/00000000-0000-7000-8000-000000000399`,
        {
          headers: { "X-Vouch-User": "u@example.com" },
        },
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Trigger not found");

      // Malformed (non-UUIDv7) anchor id is rejected without disk I/O.
      const invalidAnchor = await fetch(`${url}/runner/v/not-a-uuid/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(invalidAnchor.status).toBe(404);
      expect(await invalidAnchor.text()).toContain("Trigger not found");

      const ok = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await ok.text();
      expect(ok.status).toBe(200);
      expect(html).toContain("completed");
      expect(html).toContain("direct trigger");
      // No /raw escape hatch — the single-endpoint contract.
      expect(html).not.toContain("/raw");
    });
  });

  it("renders the trigger viewer as a safe operator event list", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000311";
    const otherTriggerId = "00000000-0000-7000-8000-000000000312";
    const anchorId = mintAnchor();
    bindSessionToAnchor("viewer-session", anchorId);
    bindSessionToAnchor("older-viewer-session", anchorId);
    expect(
      appendAlias({ aliasType: "opencode.subsession", aliasValue: "viewer-child", anchorId }),
    ).toEqual({ ok: true });
    expect(
      appendSessionEvent("viewer-session", {
        type: "trigger_start",
        triggerId,
        correlationKey: "slack:thread:1710000000.311",
      }),
    ).toEqual({ ok: true });
    appendSessionEvent("viewer-session", {
      type: "opencode_event",
      event: toolEvent("viewer-session", "read", "completed", {
        filePath: "/workspace/repos/thor/README.md",
      }),
    });
    appendSessionEvent("viewer-session", {
      type: "opencode_event",
      event: toolEvent("viewer-session", "bash", "completed", {
        command: "gh auth token --password=supersecret",
      }),
    });
    appendSessionEvent("viewer-session", {
      type: "opencode_event",
      event: toolEvent("viewer-session", "mcp", "completed", {
        token: "should-not-render",
        query: "mutation { writeThing }",
      }),
    });
    appendSessionEvent("viewer-session", {
      type: "opencode_event",
      event: textEvent("viewer-session", "Done with token=abc123"),
    });
    appendSessionEvent("viewer-session", {
      type: "opencode_event",
      event: stepFinishEvent("viewer-session"),
    });
    appendSessionEvent("viewer-session", { type: "opencode_event", event: { _truncated: true } });
    appendSessionEvent("viewer-session", {
      type: "trigger_end",
      triggerId: otherTriggerId,
      status: "completed",
    });
    appendSessionEvent("viewer-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
      durationMs: 1234,
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("slack trigger");
      expect(html).not.toContain("<h3>Activity</h3>");
      expect(html).toContain("tool</b> <span>read</span>");
      // Tool input is rendered as full JSON inside a collapsed <details>.
      expect(html).toContain("&quot;filePath&quot;");
      // No more KNOWN_BINS bash-prefix heuristic — bash rows are just `bash`.
      expect(html).toContain("tool</b> <span>bash</span>");
      expect(html).toContain("tool</b> <span>mcp</span>");
      expect(html).not.toContain("arguments hidden");
      // Truncated events render as a muted in-stream row, not a footer notice.
      expect(html).toContain('class="row truncated"');
      expect(html).toContain(">truncated event<");
      expect(html).not.toContain("opencode event was truncated at write time");
      expect(html).not.toContain("truncated payload");
      // Redaction has been removed — tokens render as-is.
      expect(html).toContain("Done with token=abc123");
      // Per-section row-count preamble removed — step list speaks for itself.
      expect(html).not.toContain("tool row(s)");
      expect(html).not.toContain("assistant text row(s)");
      expect(html).toContain('class="totals"');
      // Per-bucket token breakdown: input 10, cacheRead 4, output 20, reasoning 3 = 42 total.
      expect(html).toContain("Tokens: 10 input · 4 cached · 20 output · 3 reasoning");
      expect(html).not.toContain("Total tokens: 42");
      expect(html).not.toContain("1 step");
      expect(html).toContain('class="chips"');
      // Terminal trigger: "last event ago" is suppressed (only useful for in_flight).
      expect(html).toContain("3 tools");
      expect(html).not.toContain("last event");
      expect(html).not.toContain("step finish row(s)");
      expect(html).not.toContain(">step finish<");
      expect(html).not.toContain("cost $");
      expect(html).not.toContain("total cost");
      expect(html).not.toContain("Sanitized diagnostics");
      expect(html).not.toContain("Warnings");
      expect(html).not.toContain("meta http-equiv");
      // Debugging UI: nothing is redacted. Every value is shown as-is.
      expect(html).toContain("supersecret");
      expect(html).toContain("should-not-render");
      expect(html).toContain("mutation { writeThing }");
      expect(html).toContain("gh auth token --password");
    });
  });

  it("decodes Slack source with a clickable permalink when SLACK_TEAM_ID is set", async () => {
    process.env.SLACK_TEAM_ID = "T0TESTTEAM";
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000401";
    const anchorId = mintAnchor();
    bindSessionToAnchor("slack-source-session", anchorId);
    appendSessionEvent("slack-source-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "slack:thread:C0APZ92A45U/1710000000.401",
    });
    appendSessionEvent("slack-source-session", {
      type: "opencode_event",
      event: textEvent(
        "slack-source-session",
        '[correlation-key: slack:thread:C0APZ92A45U/1710000000.401]\n\nSlack event:\n\n{"event":{"channel":"C0APZ92A45U","user":"UN4P4F5MY","text":"deploy the new admin sessions UI"}}',
      ),
    });
    appendSessionEvent("slack-source-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    try {
      await withServer(h.app, async (url) => {
        const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
          headers: { "X-Vouch-User": "u@example.com" },
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(
          'href="https://app.slack.com/client/T0TESTTEAM/C0APZ92A45U/thread/C0APZ92A45U-1710000000.401"',
        );
        expect(html).toContain("#C0APZ92A45U");
        expect(html).toContain("@UN4P4F5MY");
        expect(html).toContain("deploy the new admin sessions UI");
        expect(html).toContain('class="source"');
      });
    } finally {
      delete process.env.SLACK_TEAM_ID;
    }
  });

  it("decodes Slack source as plain text when SLACK_TEAM_ID is unset", async () => {
    delete process.env.SLACK_TEAM_ID;
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000402";
    const anchorId = mintAnchor();
    bindSessionToAnchor("slack-noteam-session", anchorId);
    appendSessionEvent("slack-noteam-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "slack:thread:C0APZ92A45U/1710000000.402",
    });
    appendSessionEvent("slack-noteam-session", {
      type: "opencode_event",
      event: textEvent(
        "slack-noteam-session",
        '[correlation-key: slack:thread:C0APZ92A45U/1710000000.402]\n\nSlack event:\n\n{"event":{"channel":"C0APZ92A45U","user":"UN4P4F5MY","text":"hi"}}',
      ),
    });
    appendSessionEvent("slack-noteam-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("#C0APZ92A45U");
      expect(html).not.toContain("app.slack.com/client");
    });
  });

  it("decodes a GitHub PR source from the prompt preview", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000403";
    const anchorId = mintAnchor();
    bindSessionToAnchor("github-pr-session", anchorId);
    appendSessionEvent("github-pr-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "github:issue:demo:owner/repo#42",
    });
    appendSessionEvent("github-pr-session", {
      type: "opencode_event",
      event: textEvent(
        "github-pr-session",
        `[correlation-key: github:issue:demo:owner/repo#42]\n\n${JSON.stringify({
          repository: { full_name: "owner/repo" },
          sender: { login: "octocat" },
          pull_request: {
            number: 42,
            html_url: "https://github.com/owner/repo/pull/42",
            title: "Refactor the renderer",
          },
        })}`,
      ),
    });
    appendSessionEvent("github-pr-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain('href="https://github.com/owner/repo/pull/42"');
      expect(html).toContain("PR #42");
      expect(html).toContain("owner/repo");
      expect(html).toContain("@octocat");
      expect(html).toContain("Refactor the renderer");
    });
  });

  it("decodes a GitHub Issue source from the prompt preview", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000404";
    const anchorId = mintAnchor();
    bindSessionToAnchor("github-issue-session", anchorId);
    appendSessionEvent("github-issue-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "github:issue:demo:owner/repo#87",
    });
    appendSessionEvent("github-issue-session", {
      type: "opencode_event",
      event: textEvent(
        "github-issue-session",
        `[correlation-key: github:issue:demo:owner/repo#87]\n\n${JSON.stringify({
          repository: { full_name: "owner/repo" },
          sender: { login: "octocat" },
          issue: {
            number: 87,
            html_url: "https://github.com/owner/repo/issues/87",
            title: "Renderer is hard to read",
          },
        })}`,
      ),
    });
    appendSessionEvent("github-issue-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain('href="https://github.com/owner/repo/issues/87"');
      expect(html).toContain("Issue #87");
      expect(html).toContain("Renderer is hard to read");
    });
  });

  it("decodes a cron source from the prompt preview", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000405";
    const anchorId = mintAnchor();
    bindSessionToAnchor("cron-source-session", anchorId);
    appendSessionEvent("cron-source-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "cron:abcd:1700000000",
    });
    appendSessionEvent("cron-source-session", {
      type: "opencode_event",
      event: textEvent(
        "cron-source-session",
        "[correlation-key: cron:abcd:1700000000]\n\nRun the Katalon knowledge crawl using /workspace/memory/runbooks/katalon-knowledge-crawl.md.",
      ),
    });
    appendSessionEvent("cron-source-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("⏰");
      expect(html).toContain("Run the Katalon knowledge crawl");
      expect(html).not.toContain("<a href");
    });
  });

  it("renders apply_patch as a unified diff and task as a card", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000501";
    const anchorId = mintAnchor();
    bindSessionToAnchor("activity-session", anchorId);
    appendSessionEvent("activity-session", { type: "trigger_start", triggerId });
    appendSessionEvent("activity-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "apply_patch",
            state: {
              status: "completed",
              title: "Success. Updated the following files:\nM packages/runner/src/index.ts",
              input: {
                patchText:
                  "--- a/packages/runner/src/index.ts\n+++ b/packages/runner/src/index.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line\n",
              },
              time: { start: 0, end: 1000 },
            },
          },
        },
      },
    });
    appendSessionEvent("activity-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: {
                command:
                  "slack-post-message --channel C0APZ92A45U --thread-ts 1710000000.501 <<'EOF'\nHello team\nEOF",
              },
              time: { start: 0, end: 200 },
            },
          },
        },
      },
    });
    appendSessionEvent("activity-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: {
                subagent_type: "thinker",
                description: "Plan Bitbucket DC work",
                prompt: "Investigate the migration steps required for Bitbucket DC.",
              },
              time: { start: 0, end: 5000 },
            },
          },
        },
      },
    });
    appendSessionEvent("activity-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("apply_patch");
      expect(html).toContain('class="diff-add"');
      expect(html).toContain('class="diff-del"');
      expect(html).toContain("+new line");
      expect(html).toContain("-old line");
      // apply_patch diff is wrapped in a collapsed <details> by default.
      expect(html).toMatch(/<details><summary><b>apply_patch<\/b>/);
      expect(html).not.toMatch(/<details open><summary><b>apply_patch/);
      // slack-post-message bash is no longer special-cased — it renders as a
      // normal bash tool row with full input JSON inside a collapsed details.
      expect(html).toContain("tool</b> <span>bash</span>");
      expect(html).toContain("slack-post-message --channel C0APZ92A45U");
      expect(html).toContain("Hello team");
      expect(html).toContain('class="task-card"');
      expect(html).toContain("thinker");
      expect(html).toContain("Plan Bitbucket DC work");
      // Task prompt and output are wrapped in collapsed <details>.
      expect(html).toContain("<details><summary>prompt</summary>");
      expect(html).not.toContain("<details open><summary>prompt");
    });
  });

  it("groups rows into collapsible step sections with the last step open", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000503";
    const anchorId = mintAnchor();
    bindSessionToAnchor("step-group-session", anchorId);
    appendSessionEvent("step-group-session", { type: "trigger_start", triggerId });
    // Step 1: 1 tool then step-finish
    appendSessionEvent("step-group-session", {
      type: "opencode_event",
      event: toolEvent("step-group-session", "read", "completed", { filePath: "/a" }),
    });
    appendSessionEvent("step-group-session", {
      type: "opencode_event",
      event: stepFinishEvent("step-group-session"),
    });
    // Step 2: 2 tools then step-finish
    appendSessionEvent("step-group-session", {
      type: "opencode_event",
      event: toolEvent("step-group-session", "grep", "completed", { pattern: "x" }),
    });
    appendSessionEvent("step-group-session", {
      type: "opencode_event",
      event: toolEvent("step-group-session", "read", "completed", { filePath: "/b" }),
    });
    appendSessionEvent("step-group-session", {
      type: "opencode_event",
      event: stepFinishEvent("step-group-session"),
    });
    appendSessionEvent("step-group-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain('class="step"');
      expect(html).toContain('class="step-hdr">Step 1<');
      expect(html).toContain('class="step-hdr">Step 2<');
      // Two stepFinishEvents (input 10 · output 20 · reasoning 3 · cacheRead 4) doubled.
      expect(html).toContain("Tokens: 20 input · 8 cached · 40 output · 6 reasoning");
      expect(html).not.toContain("2 steps");
      // Step blocks themselves do not use <details>; only apply_patch/task do.
      expect(html).not.toContain('<li class="step"><details');
    });
  });

  it("surfaces subagent session id, preserves task prompt newlines, formats totals, and drops redundant slack prompt preview", async () => {
    process.env.SLACK_TEAM_ID = "T0TESTTEAM";
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000505";
    const anchorId = mintAnchor();
    bindSessionToAnchor("polish-session", anchorId);
    appendSessionEvent("polish-session", {
      type: "trigger_start",
      triggerId,
      correlationKey: "slack:thread:C0APZ92A45U/1710000000.505",
    });
    appendSessionEvent("polish-session", {
      type: "opencode_event",
      event: textEvent(
        "polish-session",
        '[correlation-key: slack:thread:C0APZ92A45U/1710000000.505]\n\nSlack event:\n\n{"event":{"channel":"C0APZ92A45U","user":"UN4P4F5MY","text":"deploy please"}}',
      ),
    });
    appendSessionEvent("polish-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: {
                subagent_type: "thinker",
                description: "Plan migration",
                prompt: "Line one\nLine two\nLine three",
              },
              output: "task_id: ses_subagent123\n\nAll done.",
              metadata: {
                sessionId: "ses_subagent123",
                model: { providerID: "openai", modelID: "gpt-5.5" },
              },
              time: { start: 0, end: 5000 },
            },
          },
        },
      },
    });
    appendSessionEvent("polish-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            tokens: { input: 50000, output: 30000, reasoning: 5000, cache: { read: 20044 } },
          },
        },
      },
    });
    appendSessionEvent("polish-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    try {
      await withServer(h.app, async (url) => {
        const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
          headers: { "X-Vouch-User": "u@example.com" },
        });
        const html = await response.text();
        expect(html).toContain(
          "Tokens: 50.0K input · 20.0K cached · 30.0K output · 5.0K reasoning",
        );
        // Main agent's model defaults to gpt-5.4 today; the task tool's
        // `metadata.model` is the subagent's model and is no longer
        // mis-attributed to main. No subagent session file is seeded here so
        // we stay on the single-line footer.
        expect(html).toContain("Model: gpt-5.4");
        // gpt-5.4 pricing: $2.5 input, $15 output, $0.25 cacheRead per 1M tokens.
        // 50000*2.5 + (30000+5000)*15 + 20044*0.25 = 655,011 → /1e6 = ~$0.655
        expect(html).toContain("Est cost: ~$0.655");
        expect(html).toContain("ses_subagent123");
        expect(html).toMatch(/Line one\nLine two\nLine three/);
        // Slack prompt preview is dropped because the decoded source covers it.
        expect(html).not.toContain("Prompt preview: Slack event:");
        // Decoded source line still present.
        expect(html).toContain("deploy please");
      });
    } finally {
      delete process.env.SLACK_TEAM_ID;
    }
  });

  it("renders activity flat when there is no step-finish boundary", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000504";
    const anchorId = mintAnchor();
    bindSessionToAnchor("flat-session", anchorId);
    appendSessionEvent("flat-session", { type: "trigger_start", triggerId });
    appendSessionEvent("flat-session", {
      type: "opencode_event",
      event: toolEvent("flat-session", "read", "completed", { filePath: "/a" }),
    });
    appendSessionEvent("flat-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).not.toContain('class="step"');
      expect(html).toContain("tool</b> <span>read</span>");
    });
  });

  it("inlines the subagent session activity inside the task card", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000508";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-session", anchorId);
    const subSessionId = "ses_subagent_inline_test_001";
    const taskStart = 1_700_000_000_000;
    const taskEnd = taskStart + 10_000;
    // Pre-seed the subagent's own session file with two events inside the
    // task's time window plus one stale event outside it (a later resume).
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    writeFileSync(
      `${worklogDir}/sessions/${subSessionId}.jsonl`,
      [
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 100).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                tool: "read",
                state: { status: "completed", input: { filePath: "/x" } },
              },
            },
          },
        }),
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 200).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: { type: "text", text: "Subagent finished the read." },
            },
          },
        }),
        // Event after taskEnd — belongs to a later resume of the same subagent
        // session, must NOT bleed into this task card.
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskEnd + 5_000).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: { type: "text", text: "STALE FOLLOW-UP — should not render" },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    appendSessionEvent("parent-session", { type: "trigger_start", triggerId });
    appendSessionEvent("parent-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              output: `task_id: ${subSessionId}\nAll done.`,
              metadata: { sessionId: subSessionId },
              time: { start: taskStart, end: taskEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("subagent activity (2 rows)");
      expect(html).toContain('class="events sub-events"');
      expect(html).toContain("Subagent finished the read.");
      expect(html).toContain("tool</b> <span>read</span>");
      // Stale follow-up after taskEnd is filtered out.
      expect(html).not.toContain("STALE FOLLOW-UP");
    });
  });

  it("recurses into nested subagent task tools when inlining", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000509";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-recursive", anchorId);
    const subA = "ses_subagent_recursive_a";
    const subB = "ses_subagent_recursive_b";
    const parentStart = 1_700_000_000_000;
    const parentEnd = parentStart + 10_000;
    const subATaskStart = parentStart + 500;
    const subATaskEnd = parentStart + 1_500;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    // subB just has a single read tool inside subA's task time window.
    writeFileSync(
      `${worklogDir}/sessions/${subB}.jsonl`,
      `${JSON.stringify({
        schemaVersion: 1,
        ts: new Date(subATaskStart + 100).toISOString(),
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { filePath: "/deep" } },
            },
          },
        },
      })}\n`,
    );
    // subA has a nested task tool that points to subB, inside the parent's
    // task window.
    writeFileSync(
      `${worklogDir}/sessions/${subA}.jsonl`,
      `${JSON.stringify({
        schemaVersion: 1,
        ts: new Date(subATaskStart).toISOString(),
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { subagent_type: "thinker", prompt: "deeper" },
                metadata: { sessionId: subB },
                time: { start: subATaskStart, end: subATaskEnd },
              },
            },
          },
        },
      })}\n`,
    );
    appendSessionEvent("parent-recursive", { type: "trigger_start", triggerId });
    appendSessionEvent("parent-recursive", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              metadata: { sessionId: subA },
              time: { start: parentStart, end: parentEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-recursive", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      // Two nested levels of subagent activity wrappers.
      const subMatches = html.match(/class="events sub-events"/g) ?? [];
      expect(subMatches.length).toBe(2);
      // Leaf-level read tool from subB surfaces.
      expect(html).toContain("tool</b> <span>read</span>");
    });
  });

  it("breaks subagent recursion on cycles without infinite expansion", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000510";
    const anchorId = mintAnchor();
    bindSessionToAnchor("parent-cycle", anchorId);
    const subSelf = "ses_subagent_cycle";
    const parentStart = 1_700_000_000_000;
    const parentEnd = parentStart + 10_000;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    // subSelf has a task tool that points to itself — must not infinite-loop.
    writeFileSync(
      `${worklogDir}/sessions/${subSelf}.jsonl`,
      `${JSON.stringify({
        schemaVersion: 1,
        ts: new Date(parentStart + 100).toISOString(),
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { subagent_type: "thinker", prompt: "self" },
                metadata: { sessionId: subSelf },
                time: { start: parentStart + 100, end: parentStart + 200 },
              },
            },
          },
        },
      })}\n`,
    );
    appendSessionEvent("parent-cycle", { type: "trigger_start", triggerId });
    appendSessionEvent("parent-cycle", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              metadata: { sessionId: subSelf },
              time: { start: parentStart, end: parentEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("parent-cycle", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      const subMatches = html.match(/class="events sub-events"/g) ?? [];
      // Only one expansion — the second self-reference is blocked by the
      // visited set, so the nested task card has no sub-activity block.
      expect(subMatches.length).toBe(1);
    });
  });

  it("rolls subagent tokens into a per-agent totals table when subagents are present", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000511";
    const anchorId = mintAnchor();
    bindSessionToAnchor("rollup-parent", anchorId);
    const subSessionId = "ses_subagent_rollup_001";
    const taskStart = 1_700_000_000_000;
    const taskEnd = taskStart + 10_000;
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    writeFileSync(
      `${worklogDir}/sessions/${subSessionId}.jsonl`,
      [
        // Subagent step-finish #1: 4K input, 1K cacheRead, 2K output.
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 100).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "step-finish",
                tokens: { input: 4000, output: 2000, cache: { read: 1000 } },
                state: { metadata: { model: { modelID: "gpt-5.4" } } },
              },
            },
          },
        }),
        // Subagent step-finish #2: 1K input, 3K cacheRead, 500 output, 200 reasoning.
        JSON.stringify({
          schemaVersion: 1,
          ts: new Date(taskStart + 200).toISOString(),
          type: "opencode_event",
          event: {
            type: "message.part.updated",
            properties: {
              part: {
                type: "step-finish",
                tokens: {
                  input: 1000,
                  output: 500,
                  reasoning: 200,
                  cache: { read: 3000 },
                },
              },
            },
          },
        }),
        "",
      ].join("\n"),
    );
    appendSessionEvent("rollup-parent", { type: "trigger_start", triggerId });
    // Main step-finish: 10K input, 5K cacheRead, 4K output, 1K reasoning.
    appendSessionEvent("rollup-parent", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            tokens: {
              input: 10000,
              output: 4000,
              reasoning: 1000,
              cache: { read: 5000 },
            },
          },
        },
      },
    });
    // Task tool dispatching the subagent.
    appendSessionEvent("rollup-parent", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "thinker", prompt: "go" },
              metadata: {
                sessionId: subSessionId,
                model: { providerID: "openai", modelID: "gpt-5.4" },
              },
              time: { start: taskStart, end: taskEnd },
            },
          },
        },
      },
    });
    appendSessionEvent("rollup-parent", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      // Table is rendered (replaces the single-line footer).
      expect(html).toContain('class="totals-table"');
      expect(html).not.toContain("Tokens: 10.0K input");
      // Main row + subagent row + total row.
      expect(html).toMatch(/<th[^>]*>main /);
      expect(html).toContain("task · thinker");
      expect(html).toMatch(/<th[^>]*>Total</);
      // Subagent token cells: 5.0K input · 4.0K cached · 2.5K output · 200 reasoning.
      expect(html).toMatch(/task · thinker[\s\S]*?5\.0K[\s\S]*?4\.0K[\s\S]*?2\.5K[\s\S]*?200/);
      // Totals row sums both agents: 15.0K input · 9.0K cached · 6.5K output · 1.2K reasoning.
      expect(html).toMatch(/Total[\s\S]*?15\.0K[\s\S]*?9\.0K[\s\S]*?6\.5K[\s\S]*?1\.2K/);
      // Subagent session id surfaces in the row's ledger chip.
      expect(html).toContain(subSessionId);
    });
  });

  it("renders distinct models per row when subagents use different models", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000507";
    const anchorId = mintAnchor();
    bindSessionToAnchor("multi-model-session", anchorId);
    // Seed two subagent session files, each with one step-finish.
    mkdirSync(`${worklogDir}/sessions`, { recursive: true });
    const subs: Array<{ id: string; model: string; start: number; end: number }> = [
      {
        id: "ses_subagent_modelA",
        model: "gpt-5.4",
        start: 1_700_000_000_000,
        end: 1_700_000_001_000,
      },
      {
        id: "ses_subagent_modelB",
        model: "gpt-5.5",
        start: 1_700_000_002_000,
        end: 1_700_000_003_000,
      },
    ];
    for (const s of subs) {
      writeFileSync(
        `${worklogDir}/sessions/${s.id}.jsonl`,
        [
          JSON.stringify({
            schemaVersion: 1,
            ts: new Date(s.start + 100).toISOString(),
            type: "opencode_event",
            event: {
              type: "message.part.updated",
              properties: {
                part: {
                  type: "step-finish",
                  tokens: { input: 1000, output: 500 },
                },
              },
            },
          }),
          "",
        ].join("\n"),
      );
    }
    appendSessionEvent("multi-model-session", { type: "trigger_start", triggerId });
    // Main step-finish so the main row carries tokens too.
    appendSessionEvent("multi-model-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: { part: { type: "step-finish", tokens: { input: 100, output: 200 } } },
      },
    });
    for (const s of subs) {
      appendSessionEvent("multi-model-session", {
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { subagent_type: "thinker", prompt: "go" },
                metadata: {
                  sessionId: s.id,
                  model: { providerID: "openai", modelID: s.model },
                },
                time: { start: s.start, end: s.end },
              },
            },
          },
        },
      });
    }
    appendSessionEvent("multi-model-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      // Table is rendered (subagents present).
      expect(html).toContain('class="totals-table"');
      // Main row uses hardcoded gpt-5.4 default; each subagent row uses the
      // model id taken from its parent task tool's metadata.
      expect(html).toMatch(/<th[^>]*>main [\s\S]*?<td>gpt-5\.4<\/td>/);
      expect(html).toMatch(/ses_subagent_modelA<\/code><\/th><td>gpt-5\.4<\/td>/);
      expect(html).toMatch(/ses_subagent_modelB<\/code><\/th><td>gpt-5\.5<\/td>/);
    });
  });

  it("renders the [correlation-key:] prompt echo alongside the assistant reply", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000506";
    const anchorId = mintAnchor();
    bindSessionToAnchor("prompt-echo-session", anchorId);
    appendSessionEvent("prompt-echo-session", { type: "trigger_start", triggerId });
    appendSessionEvent("prompt-echo-session", {
      type: "opencode_event",
      event: textEvent(
        "prompt-echo-session",
        "[correlation-key: slack:thread:1778250522.057779] Slack event: {...}",
      ),
    });
    appendSessionEvent("prompt-echo-session", {
      type: "opencode_event",
      event: textEvent("prompt-echo-session", "Real assistant reply."),
    });
    appendSessionEvent("prompt-echo-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      // Debugging UI shows the data as-is — the prompt echo is no longer filtered.
      expect(html).toContain("[correlation-key:");
      expect(html).toContain("Real assistant reply.");
    });
  });

  it("dedups streamed part updates by id, drops empty reasoning, and drops busy heartbeats", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-7000-8000-000000000502";
    const anchorId = mintAnchor();
    bindSessionToAnchor("dedup-session", anchorId);
    appendSessionEvent("dedup-session", { type: "trigger_start", triggerId });
    for (const text of ["he", "hel", "hello world"]) {
      appendSessionEvent("dedup-session", {
        type: "opencode_event",
        event: {
          type: "message.part.updated",
          properties: { part: { id: "prt_stream1", type: "text", text } },
        },
      });
    }
    appendSessionEvent("dedup-session", {
      type: "opencode_event",
      event: {
        type: "message.part.updated",
        properties: { part: { id: "prt_reason1", type: "reasoning", text: "" } },
      },
    });
    appendSessionEvent("dedup-session", {
      type: "opencode_event",
      event: {
        type: "session.status",
        properties: { sessionID: "dedup-session", status: { type: "busy" } },
      },
    });
    appendSessionEvent("dedup-session", {
      type: "trigger_end",
      triggerId,
      status: "completed",
    });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${anchorId}/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await response.text();
      expect(html).toContain("hello world");
      // Dedup by part.id keeps the streamed text row as a single entry.
      const occurrences = html.match(/<b>text<\/b>/g);
      expect(occurrences?.length ?? 0).toBe(1);
      // Empty reasoning parts are filtered (no payload to show).
      expect(html).not.toContain("<b>reasoning</b>");
      // session.status heartbeats are still suppressed (not in the user's
      // "restore" list — they carry no payload beyond the status pill).
      expect(html).not.toContain("<b>session.status</b>");
    });
  });

  it("creates a correlation-key session, records JSONL events, and resumes the same session", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:1710000000.001";

    await withServer(h.app, async (url) => {
      const first = await trigger(url, { prompt: "first", correlationKey });
      const firstStart = first.events.find((e) => e.type === "start");
      const firstDone = first.events.find((e) => e.type === "done");
      expect(firstStart).toMatchObject({ sessionId: "session-1", resumed: false });
      expect(firstDone).toMatchObject({
        sessionId: "session-1",
        resumed: false,
        status: "completed",
      });
      const logText = readFileSync(`${worklogDir}/sessions/session-1.jsonl`, "utf8");
      expect(logText).toContain('"type":"trigger_start"');
      expect(logText).toContain('"type":"trigger_end"');
      const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const slackAlias = aliases.find(
        (a) => a.aliasType === "slack.thread_id" && a.aliasValue === "1710000000.001",
      );
      const sessionAlias = aliases.find(
        (a) => a.aliasType === "opencode.session" && a.aliasValue === "session-1",
      );
      expect(slackAlias).toBeDefined();
      expect(sessionAlias).toBeDefined();
      expect(slackAlias.anchorId).toBe(sessionAlias.anchorId);
      expect(aliases).not.toContainEqual(expect.objectContaining({ aliasValue: correlationKey }));

      const second = await trigger(url, { prompt: "second", correlationKey });
      const secondStart = second.events.find((e) => e.type === "start");
      const secondDone = second.events.find((e) => e.type === "done");
      expect(secondStart).toMatchObject({ sessionId: "session-1", resumed: true });
      expect(secondDone).toMatchObject({
        sessionId: "session-1",
        resumed: true,
        status: "completed",
      });
    });
  });

  it("emits approval_required events only from typed output args", async () => {
    const outputArgs = {
      cloudId: "cloud-1",
      projectKey: "THOR",
      issueTypeName: "Task",
      summary: "Persisted summary",
      description: "persisted body with disclaimer",
    };
    const wrapperArgs = { upstream: "atlassian", tool: "createJiraIssue", arguments: "{}" };
    const h = createHarness({
      promptEvents: (sessionId) => [
        toolEvent(
          sessionId,
          "mcp",
          "completed",
          wrapperArgs,
          { start: 1000, end: 1200 },
          JSON.stringify({
            type: "approval_required",
            actionId: "approval-with-output-args",
            proxyName: "atlassian",
            tool: "createJiraIssue",
            args: outputArgs,
          }),
        ),
        toolEvent(sessionId, "mcp", "completed", wrapperArgs, { start: 1300, end: 1500 }, "{}"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "approval",
        correlationKey: "slack:thread:1710000000.071",
      });
      const approvals = result.events.filter((e) => e.type === "approval_required");

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        actionId: "approval-with-output-args",
        tool: "createJiraIssue",
        proxyName: "atlassian",
        args: outputArgs,
      });
    });
  });

  it("serializes direct no-session triggers for the same fresh known correlation key", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:1710000000.050";

    await withServer(h.app, async (url) => {
      const [first, second] = await Promise.all([
        trigger(url, { prompt: "first", correlationKey }),
        trigger(url, { prompt: "second", correlationKey }),
      ]);

      const starts = [first, second].map((result) => result.events.find((e) => e.type === "start"));
      expect(starts.map((event) => event?.sessionId)).toEqual(["session-1", "session-1"]);
      expect(starts.map((event) => event?.resumed).sort()).toEqual([false, true]);
    });

    expect(h.existingSessions).toEqual(new Set(["session-1"]));
    const aliases = readAliases();
    const slackAliases = aliases.filter(
      (alias) => alias.aliasType === "slack.thread_id" && alias.aliasValue === "1710000000.050",
    );
    const sessionAliases = aliases.filter(
      (alias) => alias.aliasType === "opencode.session" && alias.aliasValue === "session-1",
    );
    expect(slackAliases).toHaveLength(1);
    expect(sessionAliases).toHaveLength(1);
    expect(slackAliases[0].anchorId).toBe(sessionAliases[0].anchorId);
  });

  it("keeps unsupported direct trigger correlation keys on the raw fallback path", async () => {
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const result = await trigger(url, { prompt: "raw", correlationKey: "cron:direct" });
      expect(result.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "session-1",
        resumed: false,
      });
    });

    const aliases = readAliases();
    expect(aliases).toContainEqual(
      expect.objectContaining({ aliasType: "opencode.session", aliasValue: "session-1" }),
    );
    expect(aliases).not.toContainEqual(expect.objectContaining({ aliasValue: "cron:direct" }));
  });

  it("binds explicit-session direct trigger correlation keys to the session anchor", async () => {
    const h = createHarness({ existingSessions: new Set(["requested-session"]) });
    const anchorId = mintAnchor();
    bindSessionToAnchor("requested-session", anchorId);
    const correlationKey = "slack:thread:1710000000.060";

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "explicit",
        sessionId: "requested-session",
        correlationKey,
      });
      expect(result.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "requested-session",
        resumed: true,
      });
    });

    expect(resolveAnchorForCorrelationKey(correlationKey)).toBe(anchorId);
  });

  it("serializes session resolution for different aliases of the same session", async () => {
    const slackKey = "slack:thread:1710000000.010";
    const gitKey = "git:branch:runner-trigger-test:feature/shared";
    const sharedAnchor = mintAnchor();
    expect(
      appendAlias({
        aliasType: "opencode.session",
        aliasValue: "shared-session",
        anchorId: sharedAnchor,
      }),
    ).toEqual({ ok: true });
    expect(appendCorrelationAliasForAnchor(sharedAnchor, slackKey)).toEqual({ ok: true });
    expect(appendCorrelationAliasForAnchor(sharedAnchor, gitKey)).toEqual({ ok: true });

    let activeGets = 0;
    let maxActiveGets = 0;
    let delayedFirstGet = false;
    let resolveFirstGetStarted!: () => void;
    let releaseFirstGet!: () => void;
    const firstGetStarted = new Promise<void>((resolve) => {
      resolveFirstGetStarted = resolve;
    });
    const releaseFirstGetPromise = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const h = createHarness({
      existingSessions: new Set(["shared-session"]),
      onGet: async () => {
        activeGets++;
        maxActiveGets = Math.max(maxActiveGets, activeGets);
        try {
          if (!delayedFirstGet) {
            delayedFirstGet = true;
            resolveFirstGetStarted();
            await releaseFirstGetPromise;
          }
        } finally {
          activeGets--;
        }
      },
    });

    await withServer(h.app, async (url) => {
      const first = trigger(url, { prompt: "from slack", correlationKey: slackKey });
      await firstGetStarted;
      const second = trigger(url, { prompt: "from github", correlationKey: gitKey });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maxActiveGets).toBe(1);
      releaseFirstGet();
      await Promise.all([first, second]);
    });

    expect(maxActiveGets).toBe(1);
  });

  it("falls back from stale stored session without markdown-notes continuity", async () => {
    const h = createHarness();
    const correlationKey = "slack:thread:1710000000.002";

    await withServer(h.app, async (url) => {
      await trigger(url, { prompt: "old", correlationKey });
      h.existingSessions.delete("session-1");

      const next = await trigger(url, { prompt: "new", correlationKey });
      expect(next.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "session-2",
        resumed: false,
      });
      expect(h.prompts.at(-1)).not.toContain("Previous session was lost");
      expect(h.prompts.at(-1)).not.toContain("Your notes from the prior session are at:");
    });
  });

  it("returns busy without prompting when a resumed session is busy and interrupt is absent", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.003");

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "later",
          correlationKey: "slack:thread:1710000000.003",
          directory: sessionDir,
        }),
      });
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(h.aborts).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it("aborts then prompts when a resumed session is busy and interrupt is true", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.004");

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "now",
        correlationKey: "slack:thread:1710000000.004",
        interrupt: true,
      });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        sessionId: "busy-session",
        resumed: true,
        status: "completed",
      });
    });

    expect(h.aborts).toEqual(["busy-session"]);
    expect(h.prompts).toHaveLength(1);
  });

  it("returns busy without prompting when a resumed session is busy and interrupt is false", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    setupBusySession("1710000000.011");

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "later",
          correlationKey: "slack:thread:1710000000.011",
          directory: sessionDir,
          interrupt: false,
        }),
      });
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(h.prompts).toHaveLength(0);
  });

  it("injects memory/tool bootstrap instructions only on new sessions", async () => {
    mkdirSync(`${memoryDir}/runner-trigger-test`, { recursive: true });
    writeFileSync(`${memoryDir}/README.md`, "root memory text");
    writeFileSync(`${memoryDir}/runner-trigger-test/README.md`, "repo memory text");
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const first = await trigger(url, {
        prompt: "first",
        correlationKey: "slack:thread:1710000000.005",
      });
      expect(first.events.filter((e) => e.type === "memory")).toHaveLength(2);
      expect(h.prompts[0]).toContain("root memory text");
      expect(h.prompts[0]).toContain("repo memory text");
      const firstLogRecords = readFileSync(sessionLogPath("session-1"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const firstTriggerStart = firstLogRecords.find((record) => record.type === "trigger_start");
      // trigger_start no longer carries a promptPreview field — the prompt
      // body lives in the opencode_event stream as a `[correlation-key:]`
      // text part.
      expect(firstTriggerStart).toMatchObject({ correlationKey: "slack:thread:1710000000.005" });
      expect(firstTriggerStart).not.toHaveProperty("promptPreview");
      expect(JSON.stringify(firstTriggerStart)).not.toContain("root memory text");
      expect(JSON.stringify(firstTriggerStart)).not.toContain("repo memory text");

      await trigger(url, {
        prompt: "second",
        correlationKey: "slack:thread:1710000000.005",
      });
      expect(h.prompts[1]).not.toContain("root memory text");
      expect(h.prompts[1]).not.toContain("repo memory text");
    });
  });

  it("emits opencode.subsession aliases for discovered child sessions", async () => {
    const h = createHarness({
      children: [{ id: "child-session" }],
      promptEvents: (sessionId) => [taskRunningEvent(sessionId), idleEvent(sessionId)],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "delegate",
        correlationKey: "slack:thread:1710000000.006",
      });
      expect(result.events.find((e) => e.type === "delegate")).toMatchObject({ agent: "general" });
    });

    const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const parentAlias = aliases.find(
      (a) => a.aliasType === "opencode.session" && a.aliasValue === "session-1",
    );
    const childAlias = aliases.find(
      (a) => a.aliasType === "opencode.subsession" && a.aliasValue === "child-session",
    );
    expect(parentAlias).toBeDefined();
    expect(childAlias).toBeDefined();
    // Both bind to the same anchor so findActiveTrigger walks from child → parent.
    expect(childAlias.anchorId).toBe(parentAlias.anchorId);
  });

  it("emits session errors as tool progress and continues when later activity arrives", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [
        sessionErrorEvent(sessionId, "Input exceeds context window of this model"),
        textEvent(sessionId, "continued after compaction"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "large search",
        correlationKey: "slack:thread:1710000000.007",
      });
      expect(result.events).toContainEqual({ type: "tool", tool: "error", status: "error" });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "completed",
        response: "continued after compaction",
      });
    });
  });

  it("uses the latest session error as terminal failure when no later activity arrives", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [sessionErrorEvent(sessionId, "provider unavailable")],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, {
        prompt: "fail",
        correlationKey: "slack:thread:1710000000.008",
      });
      expect(result.events).toContainEqual({ type: "tool", tool: "error", status: "error" });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
  });

  it("returns 500 and writes no orphan trigger_start when subscribe throws before startTrigger", async () => {
    const h = createHarness({ throwInSubscribe: true });
    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "go",
          correlationKey: "slack:thread:1710000200.001",
          directory: sessionDir,
        }),
      });
      expect(response.status).toBe(500);
    });
    // No trigger_start should be on disk because subscribe threw before startTrigger ran.
    let logged = "";
    try {
      logged = readFileSync(sessionLogPath("session-1"), "utf8");
    } catch {
      // File may not exist at all — that also satisfies the invariant.
    }
    expect(logged).not.toContain('"type":"trigger_start"');
  });

  it("renders a previously orphaned trigger as 'crashed' when a newer trigger_start lands in the same session", async () => {
    const olderTriggerId = "00000000-0000-7000-8000-000000000602";
    const newerTriggerId = "00000000-0000-7000-8000-000000000603";
    const crashAnchor = mintAnchor();
    bindSessionToAnchor("crash-session", crashAnchor);
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: olderTriggerId });
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: newerTriggerId });

    const h = createHarness();
    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/${crashAnchor}/${olderTriggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("crashed");
      expect(html).toContain(`superseded by ${newerTriggerId}`);
    });
  });

  it("/internal/e2e/trigger-context rejects wrong secret and writes trigger_start on success", async () => {
    process.env.THOR_E2E_TEST_HELPERS = "1";
    process.env.THOR_INTERNAL_SECRET = "fixed-test-secret-1234567890123456";

    try {
      const h = createHarness();
      await withServer(h.app, async (url) => {
        const wrong = await fetch(`${url}/internal/e2e/trigger-context`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-thor-internal-secret": "wrong-secret-with-correct-length123",
          },
          body: JSON.stringify({}),
        });
        expect(wrong.status).toBe(401);

        const okResp = await fetch(`${url}/internal/e2e/trigger-context`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-thor-internal-secret": process.env.THOR_INTERNAL_SECRET!,
          },
          body: JSON.stringify({ correlationKey: "slack:thread:1710000200.002" }),
        });
        expect(okResp.status).toBe(200);
        const data = (await okResp.json()) as {
          sessionId: string;
          triggerId: string;
          anchorId: string;
        };
        expect(data.sessionId).toMatch(/^e2e-/);
        expect(data.triggerId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(data.anchorId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const text = readFileSync(sessionLogPath(data.sessionId), "utf8");
        expect(text).toContain(`"triggerId":"${data.triggerId}"`);
      });
    } finally {
      delete process.env.THOR_E2E_TEST_HELPERS;
      delete process.env.THOR_INTERNAL_SECRET;
    }
  });

  it("does not let status events extend the session error grace period", async () => {
    const h = createHarness({
      promptEvents: (sessionId, sub) => {
        sub.push(sessionErrorEvent(sessionId, "provider unavailable"));
        setTimeout(() => sub.push(statusEvent(sessionId)), 5);
        setTimeout(() => sub.push(statusEvent(sessionId)), 15);
      },
    });

    await withServer(h.app, async (url) => {
      const startedAt = Date.now();
      const result = await trigger(url, {
        prompt: "fail",
        correlationKey: "slack:thread:1710000000.009",
      });
      expect(Date.now() - startedAt).toBeLessThan(100);
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
  });
});
