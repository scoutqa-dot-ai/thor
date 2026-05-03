import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TextPart } from "@opencode-ai/sdk";
import { createRunnerApp, type RunnerAppOptions } from "./index.js";
import { appendAlias, appendSessionEvent, sessionLogPath } from "@thor/common";

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
        queueMicrotask(() => {
          const sub = buses.latest();
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

describe("runner /trigger orchestration", () => {
  it("serves the Vouch-gated trigger viewer with 401, 404, and rendered status", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-4000-8000-000000000301";
    expect(appendSessionEvent("viewer-session", { type: "trigger_start", triggerId })).toEqual({
      ok: true,
    });
    expect(
      appendSessionEvent("viewer-session", { type: "trigger_end", triggerId, status: "completed" }),
    ).toEqual({ ok: true });

    await withServer(h.app, async (url) => {
      const unauthorized = await fetch(`${url}/runner/v/viewer-session/${triggerId}`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.text()).toContain("Unauthorized");

      const missing = await fetch(
        `${url}/runner/v/viewer-session/00000000-0000-4000-8000-000000000399`,
        {
          headers: { "X-Vouch-User": "u@example.com" },
        },
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Trigger not found");

      const ok = await fetch(`${url}/runner/v/viewer-session/${triggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      const html = await ok.text();
      expect(ok.status).toBe(200);
      expect(html).toContain("completed");
      expect(html).toContain(`/runner/v/viewer-session/${triggerId}/raw`);
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
      expect(aliases).toContainEqual(
        expect.objectContaining({
          aliasType: "slack.thread_id",
          aliasValue: "1710000000.001",
          sessionId: "session-1",
        }),
      );
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
    expect(
      appendAlias({
        aliasType: "slack.thread_id",
        aliasValue: "1710000000.003",
        sessionId: "busy-session",
      }),
    ).toEqual({ ok: true });

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

    expect(h.prompts).toHaveLength(0);
  });

  it("aborts then prompts when a resumed session is busy and interrupt is true", async () => {
    const h = createHarness({
      existingSessions: new Set(["busy-session"]),
      busySessions: new Set(["busy-session"]),
    });
    expect(
      appendAlias({
        aliasType: "slack.thread_id",
        aliasValue: "1710000000.004",
        sessionId: "busy-session",
      }),
    ).toEqual({ ok: true });

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

      await trigger(url, {
        prompt: "second",
        correlationKey: "slack:thread:1710000000.005",
      });
      expect(h.prompts[1]).not.toContain("root memory text");
      expect(h.prompts[1]).not.toContain("repo memory text");
    });
  });

  it("emits session.parent aliases for discovered child sessions", async () => {
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

    const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8");
    expect(aliases).toContain('"aliasType":"session.parent"');
    expect(aliases).toContain('"aliasValue":"child-session"');
    expect(aliases).toContain('"sessionId":"session-1"');
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
    const olderTriggerId = "00000000-0000-4000-8000-000000000602";
    const newerTriggerId = "00000000-0000-4000-8000-000000000603";
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: olderTriggerId });
    appendSessionEvent("crash-session", { type: "trigger_start", triggerId: newerTriggerId });

    const h = createHarness();
    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/runner/v/crash-session/${olderTriggerId}`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("crashed");
      expect(html).toContain("abandoned without a close marker");
    });
  });

  it("/raw returns only the requested trigger's slice and rejects path traversal in session id", async () => {
    const triggerId = "00000000-0000-4000-8000-000000000601";
    const otherTriggerId = "00000000-0000-4000-8000-000000000698";
    appendSessionEvent("raw-session", { type: "trigger_start", triggerId });
    appendSessionEvent("raw-session", { type: "trigger_end", triggerId, status: "completed" });
    appendSessionEvent("raw-session", { type: "trigger_start", triggerId: otherTriggerId });
    appendSessionEvent("raw-session", {
      type: "trigger_end",
      triggerId: otherTriggerId,
      status: "completed",
    });

    const h = createHarness();
    await withServer(h.app, async (url) => {
      const ok = await fetch(`${url}/runner/v/raw-session/${triggerId}/raw`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).toContain(triggerId);
      expect(body).not.toContain(otherTriggerId);

      const traversal = await fetch(
        `${url}/runner/v/${encodeURIComponent("../etc/passwd")}/${triggerId}/raw`,
        { headers: { "X-Vouch-User": "u@example.com" } },
      );
      expect(traversal.status).toBe(404);
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
        const data = (await okResp.json()) as { sessionId: string; triggerId: string };
        expect(data.sessionId).toMatch(/^e2e-/);
        expect(data.triggerId).toMatch(/^[0-9a-f-]{36}$/);
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
