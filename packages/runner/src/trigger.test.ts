import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TextPart } from "@opencode-ai/sdk";
import { createRunnerApp, type RunnerAppOptions } from "./index.js";

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

function createHarness(opts: { existingSessions?: Set<string>; busySessions?: Set<string>; promptEvents?: (sessionId: string, sub: FakeSubscription) => Event[] | void } = {}) {
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
          const events = opts.promptEvents
            ? opts.promptEvents(path.id, sub)
            : [textEvent(path.id, `ok ${path.id}`), idleEvent(path.id)];
          if (!events) return;
          for (const event of events) sub.push(event);
        });
        return { data: {} };
      },
      children: async () => ({ data: [] }),
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
  if (originalEnv.sessionErrorGraceMs === undefined) delete process.env.SESSION_ERROR_GRACE_MS;
  else process.env.SESSION_ERROR_GRACE_MS = originalEnv.sessionErrorGraceMs;
  rmSync("/tmp/thor-runner-trigger-test", { recursive: true, force: true });
});

describe("runner /trigger orchestration", () => {
  it("creates a correlation-key session, records notes, and resumes the same session", async () => {
    const h = createHarness();

    await withServer(h.app, async (url) => {
      const first = await trigger(url, { prompt: "first", correlationKey: "same-key" });
      const firstStart = first.events.find((e) => e.type === "start");
      const firstDone = first.events.find((e) => e.type === "done");
      expect(firstStart).toMatchObject({ sessionId: "session-1", resumed: false });
      expect(firstDone).toMatchObject({ sessionId: "session-1", resumed: false, status: "completed" });

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

    mkdirSync(`${worklogDir}/2026-04-28/notes`, { recursive: true });
    writeFileSync(`${worklogDir}/2026-04-28/notes/busy-key.md`, "Session ID: busy-session\n");

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
    mkdirSync(`${worklogDir}/2026-04-28/notes`, { recursive: true });
    writeFileSync(`${worklogDir}/2026-04-28/notes/busy-key.md`, "Session ID: busy-session\n");

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

  it("emits session errors as tool progress and continues when later activity arrives", async () => {
    const h = createHarness({
      promptEvents: (sessionId) => [
        sessionErrorEvent(sessionId, "Input exceeds context window of this model"),
        textEvent(sessionId, "continued after compaction"),
        idleEvent(sessionId),
      ],
    });

    await withServer(h.app, async (url) => {
      const result = await trigger(url, { prompt: "large search", correlationKey: "compact-key" });
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
      const result = await trigger(url, { prompt: "fail", correlationKey: "error-key" });
      expect(result.events).toContainEqual({ type: "tool", tool: "error", status: "error" });
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
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
      const result = await trigger(url, { prompt: "fail", correlationKey: "status-key" });
      expect(Date.now() - startedAt).toBeLessThan(100);
      expect(result.events.find((e) => e.type === "done")).toMatchObject({
        status: "error",
        error: "provider unavailable",
      });
    });
  });
});
