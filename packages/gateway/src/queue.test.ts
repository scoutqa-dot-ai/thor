import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "./queue.js";

let queueDir: string;
let queue: EventQueue | null;

beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), "queue-test-"));
  queue = null;
  eventSeq = 0;
});

afterEach(() => {
  queue?.close();
  rmSync(queueDir, { recursive: true, force: true });
});

let eventSeq = 0;

function makeEvent(key: string, text: string): QueuedEvent {
  return {
    id: `test-${++eventSeq}`,
    source: "slack",
    correlationKey: key,
    payload: { text },
    receivedAt: new Date().toISOString(),
    sourceTs: Date.now(),
    readyAt: 0,
  };
}

describe("EventQueue", () => {
  it("processes a single enqueued event", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "hello"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toHaveLength(1);
    expect(handler.mock.calls[0][0][0].correlationKey).toBe("key-1");
    expect((handler.mock.calls[0][0][0].payload as { text: string }).text).toBe("hello");
  });

  it("batches multiple events for the same key into a single handler call", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "first"));
    queue.enqueue(makeEvent("key-1", "second"));
    queue.enqueue(makeEvent("key-1", "third"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(1);

    const batch = handler.mock.calls[0][0];
    expect(batch).toHaveLength(3);
    expect((batch[0].payload as { text: string }).text).toBe("first");
    expect((batch[1].payload as { text: string }).text).toBe("second");
    expect((batch[2].payload as { text: string }).text).toBe("third");
  });

  it("processes independent keys concurrently", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-a", "alpha"));
    queue.enqueue(makeEvent("key-b", "beta"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(2);
    const keys = handler.mock.calls.map((c) => c[0][0].correlationKey).sort();
    expect(keys).toEqual(["key-a", "key-b"]);
  });

  it("batches events that arrive during in-flight processing separately", async () => {
    const batches: string[][] = [];
    let resolveFirst: (() => void) | null = null;

    const handler = vi
      .fn<(events: QueuedEvent[]) => Promise<void>>()
      .mockImplementation(async (events) => {
        const texts = events.map((e) => (e.payload as { text: string }).text);
        if (texts[0] === "first") {
          // Block until we enqueue more events
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        batches.push(texts);
      });

    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Enqueue and start processing the first event
    queue.enqueue(makeEvent("key-1", "first"));
    const flushPromise = queue.flush();

    // Give the handler time to start blocking
    await new Promise((r) => setTimeout(r, 50));

    // Enqueue more events while first is in-flight
    queue.enqueue(makeEvent("key-1", "second"));
    queue.enqueue(makeEvent("key-1", "third"));

    // Unblock the first handler
    resolveFirst!();
    await flushPromise;

    // First batch: ["first"] (already processing when second+third arrived)
    // Second batch: ["second", "third"] (picked up on re-scan)
    expect(batches).toEqual([["first"], ["second", "third"]]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("cleans up processed files from the queue directory", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "hello"));
    await queue.flush();

    const remaining = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(0);
  });

  it("ignores .tmp files in the queue directory", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Write a .tmp file that should be ignored
    writeFileSync(
      join(queueDir, ".incomplete.json.tmp"),
      JSON.stringify(makeEvent("key-1", "should-be-ignored")),
    );

    await queue.flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles corrupt files without crashing", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Write a corrupt file
    writeFileSync(join(queueDir, "000000000000000_corrupt.json"), "not json{{{");

    // Write a valid event
    queue.enqueue(makeEvent("key-1", "valid"));
    await queue.flush();

    // The valid event should still be processed
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0][0].payload as { text: string }).text).toBe("valid");

    // Corrupt file should be cleaned up
    const remaining = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(0);
  });

  it("deduplicates events with the same id (retry overwrites file)", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    const event: QueuedEvent = {
      id: "same-event-id",
      source: "slack",
      correlationKey: "key-1",
      payload: { text: "original" },
      receivedAt: new Date().toISOString(),
      sourceTs: Date.now(),
      readyAt: 0,
    };

    // Enqueue the same event id twice (simulates a Slack retry)
    queue.enqueue(event);
    queue.enqueue({ ...event, payload: { text: "retry" } });
    await queue.flush();

    // Only one event processed (the retry overwrote the file)
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toHaveLength(1);
    expect((handler.mock.calls[0][0][0].payload as { text: string }).text).toBe("retry");
  });

  it("skips groups whose readyAt is in the future", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Enqueue an event with readyAt far in the future
    queue.enqueue({
      id: "future-1",
      source: "slack",
      correlationKey: "key-1",
      payload: { text: "not yet" },
      receivedAt: new Date().toISOString(),
      sourceTs: Date.now(),
      readyAt: Date.now() + 60_000,
    });

    await queue.flush();

    // Should not have been processed — readyAt hasn't passed
    expect(handler).not.toHaveBeenCalled();

    // File should still be in the queue directory
    const remaining = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(1);
  });

  it("handler errors do not prevent subsequent events from processing", async () => {
    let callCount = 0;
    const handler = vi
      .fn<(events: QueuedEvent[]) => Promise<void>>()
      .mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("handler failed");
      });

    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "will-fail"));
    await queue.flush();

    // Now enqueue another event — should still be processed
    queue.enqueue(makeEvent("key-1", "will-succeed"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
