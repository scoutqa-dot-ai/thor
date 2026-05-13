import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Event, GlobalEvent, TextPart } from "@opencode-ai/sdk";
import { EventBusRegistry, SessionSubscription, waitForSessionSettled } from "./event-bus.js";

vi.mock("@opencode-ai/sdk", () => {
  return {
    createOpencodeClient: vi.fn(),
  };
});

import { createOpencodeClient } from "@opencode-ai/sdk";

function makePartEvent(sessionID: string, text = `text ${sessionID}`): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `p-${sessionID}`,
        sessionID,
        type: "text",
        messageID: `m-${sessionID}`,
        text,
      } satisfies TextPart,
    },
  };
}

function makeIdleEvent(sessionID: string): Event {
  return {
    type: "session.idle",
    properties: { sessionID },
  };
}

function makeErrorEvent(sessionID: string): Event {
  return {
    type: "session.error",
    properties: { sessionID, error: { name: "UnknownError", data: { message: "test" } } },
  };
}

function makeGlobalEvent(directory: string, event: Event): GlobalEvent {
  return {
    directory,
    payload: event,
  };
}

function createMockStream() {
  const events: GlobalEvent[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;
  const iteratorReturn = vi.fn(async () => {
    closed = true;
    resolve?.();
    return { value: undefined as never, done: true };
  });

  const push = (event: GlobalEvent) => {
    events.push(event);
    resolve?.();
  };

  const end = () => {
    closed = true;
    resolve?.();
  };

  const stream: AsyncIterable<GlobalEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<GlobalEvent>> {
          while (events.length === 0 && !closed) {
            await new Promise<void>((r) => {
              resolve = r;
            });
            resolve = null;
          }
          if (events.length > 0) {
            return { value: events.shift(), done: false };
          }
          return { value: undefined as never, done: true };
        },
        return: iteratorReturn,
      };
    },
  };

  return { stream, push, end, iteratorReturn };
}

async function collectUntilIdle(sub: AsyncIterable<Event>): Promise<Event[]> {
  const items: Event[] = [];
  for await (const event of sub) {
    items.push(event);
    if (event.type === "session.idle") break;
  }
  return items;
}

async function* eventIterable(events: Event[]) {
  for (const event of events) yield event;
}

describe("SessionSubscription", () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  it("close() removes every emitter listener it registered", () => {
    const sub = new SessionSubscription(emitter, ["s1", "s2"]);
    expect(emitter.listenerCount("s1")).toBe(1);
    expect(emitter.listenerCount("s2")).toBe(1);

    sub.close();

    expect(emitter.listenerCount("s1")).toBe(0);
    expect(emitter.listenerCount("s2")).toBe(0);
  });

  it("close() is idempotent", () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    sub.close();
    sub.close();
    expect(emitter.listenerCount("s1")).toBe(0);
  });

  it("close() unblocks a pending next() so iteration ends cleanly", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    const iteration = (async () => {
      const items: Event[] = [];
      for await (const event of sub) items.push(event);
      return items;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.close();
    await expect(iteration).resolves.toEqual([]);
  });

  it("addSessionId() after close() does not re-register a listener", () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    sub.close();
    sub.addSessionId("s2");
    expect(emitter.listenerCount("s2")).toBe(0);
  });

  it("addSessionId() is idempotent for the same session id", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    sub.addSessionId("s1");
    sub.addSessionId("s1");
    expect(emitter.listenerCount("s1")).toBe(1);

    emitter.emit("s1", makeIdleEvent("s1"));
    const items: Event[] = [];
    for await (const event of sub) {
      items.push(event);
      break;
    }
    expect(items).toHaveLength(1);
    sub.close();
  });

  it("deduplicates session ids passed to the constructor", () => {
    const sub = new SessionSubscription(emitter, ["s1", "s1"]);
    expect(emitter.listenerCount("s1")).toBe(1);
    sub.close();
  });
});

describe("EventBusRegistry", () => {
  let mockStream: ReturnType<typeof createMockStream>;
  let subscribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStream = createMockStream();
    subscribeMock = vi.fn().mockResolvedValue({ stream: mockStream.stream });
    vi.mocked(createOpencodeClient).mockReturnValue({
      global: {
        event: subscribeMock,
      },
    } as never);
  });

  it("opens one global OpenCode stream for subscriptions", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const [sub1, sub2] = await Promise.all([reg.subscribe(["s1"]), reg.subscribe(["s2"])]);

    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createOpencodeClient).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(config).toMatchObject({ baseUrl: "http://localhost:4096" });
    expect(config).not.toHaveProperty("directory");
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    sub1.close();
    sub2.close();
  });

  it("routes global events by session", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const repoASession1 = await reg.subscribe(["s1"]);
    const repoASession2 = await reg.subscribe(["s2"]);
    const repoBSession3 = await reg.subscribe(["s3"]);

    const a1Part = makePartEvent("s1", "repo a s1");
    const a1Idle = makeIdleEvent("s1");
    const a2Part = makePartEvent("s2", "repo a s2");
    const a2Idle = makeIdleEvent("s2");
    const b3Part = makePartEvent("s3", "repo b s3");
    const b3Idle = makeIdleEvent("s3");

    const a1 = collectUntilIdle(repoASession1);
    const a2 = collectUntilIdle(repoASession2);
    const b3 = collectUntilIdle(repoBSession3);

    mockStream.push(makeGlobalEvent("/repo/a", a2Part));
    mockStream.push(makeGlobalEvent("/repo/b", b3Part));
    mockStream.push(makeGlobalEvent("/repo/a", a1Part));
    mockStream.push(makeGlobalEvent("/repo/a", a2Idle));
    mockStream.push(makeGlobalEvent("/repo/b", b3Idle));
    mockStream.push(makeGlobalEvent("/repo/a", a1Idle));

    await expect(a1).resolves.toEqual([a1Part, a1Idle]);
    await expect(a2).resolves.toEqual([a2Part, a2Idle]);
    await expect(b3).resolves.toEqual([b3Part, b3Idle]);
  });

  it("includes child session events after the subscription adds the child id", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub = await reg.subscribe(["parent"]);
    sub.addSessionId("child");

    const childPart = makePartEvent("child", "child progress");
    const parentIdle = makeIdleEvent("parent");
    const collected = collectUntilIdle(sub);

    mockStream.push(makeGlobalEvent("/repo/a", childPart));
    mockStream.push(makeGlobalEvent("/repo/a", parentIdle));

    await expect(collected).resolves.toEqual([childPart, parentIdle]);
  });

  it("keeps the global stream open until the last active subscription closes", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe(["s1"]);
    const sub2 = await reg.subscribe(["s2"]);

    sub1.close();
    expect(mockStream.iteratorReturn).not.toHaveBeenCalled();

    sub2.close();
    await vi.waitFor(() => expect(mockStream.iteratorReturn).toHaveBeenCalledTimes(1));
  });

  it("does not reconnect after the stream closes with no active subscriptions", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub = await reg.subscribe(["s1"]);
    sub.close();

    await vi.waitFor(() => expect(mockStream.iteratorReturn).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
  });

  it("reconnects existing subscriptions when the global stream ends", async () => {
    const newMockStream = createMockStream();
    let callCount = 0;
    vi.mocked(createOpencodeClient).mockImplementation(() => {
      callCount++;
      const selectedStream = callCount === 1 ? mockStream : newMockStream;
      return {
        global: {
          event: vi.fn().mockResolvedValue({ stream: selectedStream.stream }),
        },
      } as never;
    });
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub = await reg.subscribe(["s1"]);
    const collected = collectUntilIdle(sub);
    mockStream.end();
    // Reconnect is gated by RECONNECT_MIN_DELAY_MS (1s) to prevent tight loops.
    await vi.waitFor(() => expect(createOpencodeClient).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });

    const idle = makeIdleEvent("s1");
    newMockStream.push(makeGlobalEvent("/repo/a", idle));

    await expect(collected).resolves.toEqual([idle]);
  });

  it("waits at least RECONNECT_MIN_DELAY_MS between reconnects after a stream close", async () => {
    let callCount = 0;
    const streams = [createMockStream(), createMockStream()];
    vi.mocked(createOpencodeClient).mockImplementation(() => {
      const selected = streams[callCount++] ?? createMockStream();
      return {
        global: {
          event: vi.fn().mockResolvedValue({ stream: selected.stream }),
        },
      } as never;
    });
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub = await reg.subscribe(["s1"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);

    const start = Date.now();
    streams[0]!.end();
    await vi.waitFor(() => expect(createOpencodeClient).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);

    sub.close();
  });
});

describe("waitForSessionSettled", () => {
  it("treats idle and error events as settled", async () => {
    await expect(waitForSessionSettled(eventIterable([makeIdleEvent("s1")]), 1_000)).resolves.toBe(
      true,
    );
    await expect(waitForSessionSettled(eventIterable([makeErrorEvent("s1")]), 1_000)).resolves.toBe(
      true,
    );
  });

  it("returns false when the event stream ends before the session settles", async () => {
    await expect(waitForSessionSettled(eventIterable([makePartEvent("s1")]), 1_000)).resolves.toBe(
      false,
    );
  });

  it("resolves false when the timeout fires before any settle event arrives", async () => {
    const emitter = new EventEmitter();
    const sub = new SessionSubscription(emitter, ["s1"]);
    try {
      // Stream stays open with no settle event — timeout has to win.
      await expect(waitForSessionSettled(sub, 30)).resolves.toBe(false);
    } finally {
      sub.close();
    }
  });
});
