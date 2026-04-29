import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Event } from "@opencode-ai/sdk";
import { EventBusRegistry, SessionSubscription, waitForSessionSettled } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePartEvent(sessionID: string, partType = "text"): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: { sessionID, type: partType, messageID: "m1" } as never,
    },
  } as unknown as Event;
}

function makeIdleEvent(sessionID: string): Event {
  return {
    type: "session.idle",
    properties: { sessionID },
  } as unknown as Event;
}

function makeErrorEvent(sessionID: string): Event {
  return {
    type: "session.error",
    properties: { sessionID, error: { name: "test" } },
  } as unknown as Event;
}

// ---------------------------------------------------------------------------
// SessionSubscription (unit tests — no SSE mock needed)
// ---------------------------------------------------------------------------

describe("SessionSubscription", () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  it("yields events matching the subscribed session ID", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);

    emitter.emit("s1", makePartEvent("s1"));
    emitter.emit("s1", makeIdleEvent("s1"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      if (event.type === "session.idle") break;
    }

    expect(collected).toHaveLength(2);
    expect(collected[0].type).toBe("message.part.updated");
    expect(collected[1].type).toBe("session.idle");
  });

  it("does not receive events from other sessions", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);

    // Emit for a different session — should not arrive.
    emitter.emit("s2", makePartEvent("s2"));
    // Emit for our session.
    emitter.emit("s1", makeIdleEvent("s1"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      if (event.type === "session.idle") break;
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe("session.idle");
  });

  it("addSessionId() dynamically includes child session events", async () => {
    const sub = new SessionSubscription(emitter, ["parent"]);

    // Child events before addSessionId — should be missed.
    emitter.emit("child1", makePartEvent("child1"));

    sub.addSessionId("child1");

    emitter.emit("child1", makePartEvent("child1"));
    emitter.emit("parent", makeIdleEvent("parent"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      if (event.type === "session.idle") break;
    }

    // child1 part + parent idle
    expect(collected).toHaveLength(2);
  });

  it("addSessionId() is idempotent", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    sub.addSessionId("s1");
    sub.addSessionId("s1");

    emitter.emit("s1", makeIdleEvent("s1"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      break;
    }

    // Should get exactly 1 event, not duplicates.
    expect(collected).toHaveLength(1);
  });

  it("deduplicates initial session IDs", () => {
    const sub = new SessionSubscription(emitter, ["s1", "s1"]);

    expect(emitter.listenerCount("s1")).toBe(1);

    sub.close();
    expect(emitter.listenerCount("s1")).toBe(0);
  });

  it("close() unblocks a pending next()", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);

    // Start iterating in the background — it will block waiting for events.
    const promise = (async () => {
      const items: Event[] = [];
      for await (const event of sub) {
        items.push(event);
      }
      return items;
    })();

    // Give the iterator time to enter the await.
    await new Promise((r) => setTimeout(r, 10));

    sub.close();

    const items = await promise;
    expect(items).toHaveLength(0);
  });

  it("close() removes all listeners from the emitter", async () => {
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
    sub.close(); // Should not throw.
    expect(emitter.listenerCount("s1")).toBe(0);
  });

  it("addSessionId() after close() is a no-op", () => {
    const sub = new SessionSubscription(emitter, ["s1"]);
    sub.close();
    sub.addSessionId("s2");
    expect(emitter.listenerCount("s2")).toBe(0);
  });

  it("events arriving before iteration are buffered", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);

    // Emit before anyone iterates.
    emitter.emit("s1", makePartEvent("s1"));
    emitter.emit("s1", makePartEvent("s1"));
    emitter.emit("s1", makeIdleEvent("s1"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      if (event.type === "session.idle") break;
    }

    expect(collected).toHaveLength(3);
  });

  it("handles session.error events", async () => {
    const sub = new SessionSubscription(emitter, ["s1"]);

    emitter.emit("s1", makeErrorEvent("s1"));

    const collected: Event[] = [];
    for await (const event of sub) {
      collected.push(event);
      if (event.type === "session.error") break;
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe("session.error");
  });
});

// ---------------------------------------------------------------------------
// waitForSessionSettled
// ---------------------------------------------------------------------------

describe("waitForSessionSettled", () => {
  it("resolves true on session.idle (successful completion)", async () => {
    const emitter = new EventEmitter();
    const sub = new SessionSubscription(emitter, ["s1"]);
    emitter.emit("s1", makeIdleEvent("s1"));

    const settled = await waitForSessionSettled(sub, 1_000);
    sub.close();
    expect(settled).toBe(true);
  });

  it("resolves true on session.error (abort emits error, not idle)", async () => {
    const emitter = new EventEmitter();
    const sub = new SessionSubscription(emitter, ["s1"]);
    emitter.emit("s1", makeErrorEvent("s1"));

    const settled = await waitForSessionSettled(sub, 1_000);
    sub.close();
    expect(settled).toBe(true);
  });

  it("ignores unrelated events until settled", async () => {
    const emitter = new EventEmitter();
    const sub = new SessionSubscription(emitter, ["s1"]);
    emitter.emit("s1", makePartEvent("s1"));
    emitter.emit("s1", makePartEvent("s1"));
    emitter.emit("s1", makeErrorEvent("s1"));

    const settled = await waitForSessionSettled(sub, 1_000);
    sub.close();
    expect(settled).toBe(true);
  });

  it("resolves false on timeout when no settle event arrives", async () => {
    const emitter = new EventEmitter();
    const sub = new SessionSubscription(emitter, ["s1"]);

    const settled = await waitForSessionSettled(sub, 50);
    sub.close();
    expect(settled).toBe(false);
  });

  it("clears the timeout when a settle event wins", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const sub = new SessionSubscription(emitter, ["s1"]);
      emitter.emit("s1", makeIdleEvent("s1"));

      const settled = await waitForSessionSettled(sub, 1_000);
      sub.close();

      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCodeEventBus (integration-level — mock the SDK)
// ---------------------------------------------------------------------------

// We mock createOpencodeClient to return a controllable async iterable.
vi.mock("@opencode-ai/sdk", () => {
  return {
    createOpencodeClient: vi.fn(),
  };
});

import { createOpencodeClient } from "@opencode-ai/sdk";

function createMockStream() {
  const events: Event[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;
  const iteratorReturn = vi.fn(async () => {
    closed = true;
    resolve?.();
    return { value: undefined as never, done: true };
  });

  const push = (event: Event) => {
    events.push(event);
    resolve?.();
  };

  const end = () => {
    closed = true;
    resolve?.();
  };

  const stream: AsyncIterable<Event> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Event>> {
          while (events.length === 0 && !closed) {
            await new Promise<void>((r) => {
              resolve = r;
            });
            resolve = null;
          }
          if (events.length > 0) {
            return { value: events.shift()!, done: false };
          }
          return { value: undefined as never, done: true };
        },
        return: iteratorReturn,
      };
    },
  };

  return { stream, push, end, iteratorReturn };
}

describe("EventBusRegistry", () => {
  let mockStream: ReturnType<typeof createMockStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStream = createMockStream();
    vi.mocked(createOpencodeClient).mockReturnValue({
      event: {
        subscribe: vi.fn().mockResolvedValue({ stream: mockStream.stream }),
      },
    } as never);
  });

  it("connects lazily on first subscribe()", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    expect(createOpencodeClient).not.toHaveBeenCalled();

    await reg.subscribe("/repo/a", ["s1"]);

    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/repo/a" }),
    );
  });

  it("reuses the same connection for same directory", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    await reg.subscribe("/repo/a", ["s1"]);
    await reg.subscribe("/repo/a", ["s2"]);

    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
  });

  it("creates separate connections for different directories", async () => {
    const streamB = createMockStream();
    let callCount = 0;
    vi.mocked(createOpencodeClient).mockImplementation(() => {
      callCount++;
      const s = callCount === 1 ? mockStream : streamB;
      return {
        event: {
          subscribe: vi.fn().mockResolvedValue({ stream: s.stream }),
        },
      } as never;
    });

    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe("/repo/a", ["s1"]);
    const sub2 = await reg.subscribe("/repo/b", ["s2"]);

    expect(createOpencodeClient).toHaveBeenCalledTimes(2);
    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/repo/a" }),
    );
    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/repo/b" }),
    );

    // Events on stream A go to sub1, events on stream B go to sub2.
    mockStream.push(makeIdleEvent("s1"));
    streamB.push(makeIdleEvent("s2"));

    const collect = async (sub: SessionSubscription) => {
      const items: Event[] = [];
      for await (const event of sub) {
        items.push(event);
        if (event.type === "session.idle") break;
      }
      return items;
    };

    const [r1, r2] = await Promise.all([collect(sub1), collect(sub2)]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it("dispatches events to the correct subscription", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe("/repo/a", ["s1"]);
    const sub2 = await reg.subscribe("/repo/a", ["s2"]);

    mockStream.push(makePartEvent("s1"));
    mockStream.push(makePartEvent("s2"));
    mockStream.push(makeIdleEvent("s1"));
    mockStream.push(makeIdleEvent("s2"));

    const collect = async (sub: SessionSubscription) => {
      const items: Event[] = [];
      for await (const event of sub) {
        items.push(event);
        if (event.type === "session.idle") break;
      }
      return items;
    };

    const [r1, r2] = await Promise.all([collect(sub1), collect(sub2)]);

    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(2);
    expect((r1[0] as any).properties.part.sessionID).toBe("s1");
    expect((r2[0] as any).properties.part.sessionID).toBe("s2");
  });

  it("reconnects on next subscribe() after stream failure", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe("/repo/a", ["s1"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);

    // Simulate stream ending.
    mockStream.end();
    await new Promise((r) => setTimeout(r, 20));

    // Create a fresh mock stream for the reconnection.
    const newMockStream = createMockStream();
    vi.mocked(createOpencodeClient).mockReturnValue({
      event: {
        subscribe: vi.fn().mockResolvedValue({ stream: newMockStream.stream }),
      },
    } as never);

    const sub2 = await reg.subscribe("/repo/a", ["s2"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(2);

    newMockStream.push(makeIdleEvent("s2"));

    const collected: Event[] = [];
    for await (const event of sub2) {
      collected.push(event);
      if (event.type === "session.idle") break;
    }
    expect(collected).toHaveLength(1);

    sub1.close();
  });

  it("coalesces concurrent subscribe() calls into one connection per directory", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const [sub1, sub2] = await Promise.all([
      reg.subscribe("/repo/a", ["s1"]),
      reg.subscribe("/repo/a", ["s2"]),
    ]);

    expect(createOpencodeClient).toHaveBeenCalledTimes(1);

    sub1.close();
    sub2.close();
  });

  it("keeps a directory bus until its last subscription closes", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe("/repo/a", ["s1"]);
    const sub2 = await reg.subscribe("/repo/a", ["s2"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);

    sub1.close();
    const sub3 = await reg.subscribe("/repo/a", ["s3"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);

    sub2.close();
    sub3.close();
  });

  it("removes and closes a directory bus when its last subscription closes", async () => {
    const reg = new EventBusRegistry("http://localhost:4096");

    const sub1 = await reg.subscribe("/repo/a", ["s1"]);
    sub1.close();

    await vi.waitFor(() => expect(mockStream.iteratorReturn).toHaveBeenCalledTimes(1));

    const newMockStream = createMockStream();
    vi.mocked(createOpencodeClient).mockReturnValue({
      event: {
        subscribe: vi.fn().mockResolvedValue({ stream: newMockStream.stream }),
      },
    } as never);

    const sub2 = await reg.subscribe("/repo/a", ["s2"]);
    expect(createOpencodeClient).toHaveBeenCalledTimes(2);

    newMockStream.push(makeIdleEvent("s2"));
    const collected: Event[] = [];
    for await (const event of sub2) {
      collected.push(event);
      break;
    }
    expect(collected).toHaveLength(1);

    sub2.close();
  });
});
