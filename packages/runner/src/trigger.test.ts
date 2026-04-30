import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TextPart } from "@opencode-ai/sdk";
import { createRunnerApp, type RunnerAppOptions } from "./index.js";
import { appendAlias, appendSessionEvent } from "@thor/common";

const worklogDir = "/tmp/thor-runner-trigger-test/worklog";
vi.hoisted(() => {
  process.env.WORKLOG_DIR = "/tmp/thor-runner-trigger-test/worklog";
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

function createHarness(opts: { existingSessions?: Set<string>; busySessions?: Set<string>; children?: Array<{ id: string }>; promptEvents?: (sessionId: string) => Event[] } = {}) {
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
        data: Object.fromEntries(
          [...busySessions].map((id) => [id, { type: "busy" }]),
        ),
      }),
      abort: async ({ path }: { path: { id: string } }) => {
        aborts.push(path.id);
        busySessions.delete(path.id);
        abortedPending.add(path.id);
        return { data: {} };
      },
      promptAsync: async ({ path, body }: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        prompts.push(body.parts[0]?.text ?? "");
        queueMicrotask(() => {
          const sub = buses.latest();
          const events = opts.promptEvents?.(path.id) ?? [textEvent(path.id, `ok ${path.id}`), idleEvent(path.id)];
          for (const event of events) sub.push(event);
        });
        return { data: {} };
      },
      children: async () => ({ data: opts.children ?? [] }),
    },
  };

  const app = createRunnerApp({
    eventBuses: {
      subscribe: async () => {
        const sub = await buses.subscribe();
        for (const id of abortedPending) {
          queueMicrotask(() => sub.push(idleEvent(id)));
          abortedPending.delete(id);
        }
        return sub;
      },
    } as unknown as RunnerAppOptions["eventBuses"],
    memoryDir,
    createClient: () => client as unknown as ReturnType<NonNullable<RunnerAppOptions["createClient"]>>,
    ensureOpencodeAvailable: async () => {},
    isOpencodeReachable: async () => true,
  });

  return { app, prompts, aborts, existingSessions, busySessions };
}

async function withServer<T>(app: ReturnType<typeof createRunnerApp>, fn: (url: string) => Promise<T>) {
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
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
});

describe("runner /trigger orchestration", () => {
  it("serves the Vouch-gated trigger viewer with 401, 404, and rendered status", async () => {
    const h = createHarness();
    const triggerId = "00000000-0000-4000-8000-000000000301";
    expect(appendSessionEvent("viewer-session", { type: "trigger_start", triggerId })).toEqual({ ok: true });
    expect(appendSessionEvent("viewer-session", { type: "trigger_end", triggerId, status: "completed" })).toEqual({ ok: true });

    await withServer(h.app, async (url) => {
      const unauthorized = await fetch(`${url}/runner/v/viewer-session/${triggerId}`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.text()).toContain("Unauthorized");

      const missing = await fetch(`${url}/runner/v/viewer-session/00000000-0000-4000-8000-000000000399`, {
        headers: { "X-Vouch-User": "u@example.com" },
      });
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

  it("creates a correlation-key session, records notes, and resumes the same session", async () => {
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const first = await trigger(url, { prompt: "first", correlationKey: "same-key" });
      const firstStart = first.events.find((e) => e.type === "start");
      const firstDone = first.events.find((e) => e.type === "done");
      expect(firstStart).toMatchObject({ sessionId: "session-1", resumed: false });
      expect(firstDone).toMatchObject({ sessionId: "session-1", resumed: false, status: "completed" });
      const logText = readFileSync(`${worklogDir}/sessions/session-1.jsonl`, "utf8");
      expect(logText).toContain('"type":"trigger_start"');
      expect(logText).toContain('"type":"trigger_end"');

      const second = await trigger(url, { prompt: "second", correlationKey: "same-key" });
      const secondStart = second.events.find((e) => e.type === "start");
      const secondDone = second.events.find((e) => e.type === "done");
      expect(secondStart).toMatchObject({ sessionId: "session-1", resumed: true });
      expect(secondDone).toMatchObject({ sessionId: "session-1", resumed: true, status: "completed" });
    });
  });

  it("falls back from stale stored session and includes a previous-notes hint", async () => {
    const h = createHarness();

    await withServer(h.app, async (url) => {
      await trigger(url, { prompt: "old", correlationKey: "stale-key" });
      h.existingSessions.delete("session-1");

      const next = await trigger(url, { prompt: "new", correlationKey: "stale-key" });
      expect(next.events.find((e) => e.type === "start")).toMatchObject({
        sessionId: "session-2",
        resumed: false,
      });
      expect(h.prompts.at(-1)).toContain("Previous session was lost");
      expect(h.prompts.at(-1)).toContain("Your notes from the prior session are at:");
    });
  });

  it("returns busy without prompting when a resumed session is busy and interrupt is absent", async () => {
    const h = createHarness({ existingSessions: new Set(["busy-session"]), busySessions: new Set(["busy-session"]) });
    expect(appendAlias({ aliasType: "slack.thread_id", aliasValue: "busy-key", sessionId: "busy-session" })).toEqual({ ok: true });

    await withServer(h.app, async (url) => {
      const response = await fetch(`${url}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "later", correlationKey: "busy-key", directory: sessionDir }),
      });
      expect(await response.json()).toEqual({ busy: true });
    });

    expect(h.prompts).toHaveLength(0);
  });

  it("aborts then prompts when a resumed session is busy and interrupt is true", async () => {
    const h = createHarness({ existingSessions: new Set(["busy-session"]), busySessions: new Set(["busy-session"]) });
    expect(appendAlias({ aliasType: "slack.thread_id", aliasValue: "busy-key", sessionId: "busy-session" })).toEqual({ ok: true });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, { prompt: "now", correlationKey: "busy-key", interrupt: true });
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
      const first = await trigger(url, { prompt: "first", correlationKey: "memory-key" });
      expect(first.events.filter((e) => e.type === "memory")).toHaveLength(2);
      expect(h.prompts[0]).toContain("root memory text");
      expect(h.prompts[0]).toContain("repo memory text");

      await trigger(url, { prompt: "second", correlationKey: "memory-key" });
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
      const result = await trigger(url, { prompt: "delegate", correlationKey: "child-key" });
      expect(result.events.find((e) => e.type === "delegate")).toMatchObject({ agent: "general" });
    });

    const aliases = readFileSync(`${worklogDir}/aliases.jsonl`, "utf8");
    expect(aliases).toContain('"aliasType":"session.parent"');
    expect(aliases).toContain('"aliasValue":"child-session"');
    expect(aliases).toContain('"sessionId":"session-1"');
  });
});
