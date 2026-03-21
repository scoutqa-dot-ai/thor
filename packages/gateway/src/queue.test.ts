import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "./queue.js";

let queueDir: string;
let queue: EventQueue | null;

// Controllable clock for deterministic tests.
const BASE_TIME = 1_000_000_000_000;
let now = BASE_TIME;
vi.spyOn(Date, "now").mockImplementation(() => now);

function setTime(ms: number): void {
  now = ms;
}

beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), "queue-test-"));
  queue = null;
  eventSeq = 0;
  now = BASE_TIME;
});

afterEach(() => {
  queue?.close();
  rmSync(queueDir, { recursive: true, force: true });
});

let eventSeq = 0;

/** Helper: create a non-interrupt event. */
function makeEvent(key: string, text: string, delayMs = 0): QueuedEvent {
  return {
    id: `test-${++eventSeq}`,
    source: "slack",
    correlationKey: key,
    payload: { text },
    receivedAt: new Date().toISOString(),
    sourceTs: now,
    readyAt: delayMs > 0 ? now + delayMs : 0,
    delayMs,
  };
}

/** Helper: create an interrupt (mention) event. */
function makeMention(key: string, text: string, delayMs = 3_000): QueuedEvent {
  return {
    id: `test-${++eventSeq}`,
    source: "slack",
    correlationKey: key,
    payload: { text },
    receivedAt: new Date().toISOString(),
    sourceTs: now,
    readyAt: now + delayMs,
    delayMs,
    interrupt: true,
  };
}

/** Extract text payloads from handler calls, grouped by batch. */
function batchTexts(handler: ReturnType<typeof vi.fn>): string[][] {
  return handler.mock.calls.map((c: [QueuedEvent[]]) =>
    c[0].map((e: QueuedEvent) => (e.payload as { text: string }).text),
  );
}

describe("EventQueue", () => {
  // ---------------------------------------------------------------------------
  // Core mechanics
  // ---------------------------------------------------------------------------

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
    const keys = handler.mock.calls.map((c: [QueuedEvent[]]) => c[0][0].correlationKey).sort();
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
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        batches.push(texts);
      });

    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "first"));
    const flushPromise = queue.flush();

    await new Promise((r) => setTimeout(r, 50));

    queue.enqueue(makeEvent("key-1", "second"));
    queue.enqueue(makeEvent("key-1", "third"));

    resolveFirst!();
    await flushPromise;

    expect(batches).toEqual([["first"], ["second", "third"]]);
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

    writeFileSync(join(queueDir, "000000000000000_corrupt.json"), "not json{{{");
    queue.enqueue(makeEvent("key-1", "valid"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0][0].payload as { text: string }).text).toBe("valid");

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
      sourceTs: now,
      readyAt: 0,
      delayMs: 0,
    };

    queue.enqueue(event);
    queue.enqueue({ ...event, payload: { text: "retry" } });
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toHaveLength(1);
    expect((handler.mock.calls[0][0][0].payload as { text: string }).text).toBe("retry");
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

    queue.enqueue(makeEvent("key-1", "will-succeed"));
    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Scenario tests (see docs/plan/2026032101_mention-interrupt.md)
  // ---------------------------------------------------------------------------

  it("S1: mention while idle — fires after 3s debounce", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeMention("key-1", "hey @thor"));

    // Before debounce window
    setTime(BASE_TIME + 2_999);
    await queue.flush();
    expect(handler).not.toHaveBeenCalled();

    // After debounce window
    setTime(BASE_TIME + 3_000);
    await queue.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(batchTexts(handler)).toEqual([["hey @thor"]]);
  });

  it("S4: non-mention, no session — fires after 60s", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "just a message", 60_000));

    setTime(BASE_TIME + 59_999);
    await queue.flush();
    expect(handler).not.toHaveBeenCalled();

    setTime(BASE_TIME + 60_000);
    await queue.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(batchTexts(handler)).toEqual([["just a message"]]);
  });

  it("S5: multiple rapid mentions debounce — sliding 3s window", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Mention at T+0 (readyAt = T+3s)
    queue.enqueue(makeMention("key-1", "mention-1"));

    // Mention at T+1s (readyAt = T+4s) — slides the window
    setTime(BASE_TIME + 1_000);
    queue.enqueue(makeMention("key-1", "mention-2"));

    // At T+3.5s — first mention's readyAt passed but batch max is T+4s
    setTime(BASE_TIME + 3_500);
    await queue.flush();
    expect(handler).not.toHaveBeenCalled();

    // At T+4s — both fire together
    setTime(BASE_TIME + 4_000);
    await queue.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(batchTexts(handler)).toEqual([["mention-1", "mention-2"]]);
  });

  it("S6: non-mention pending, then mention arrives — mention pulls batch forward", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Non-mention at T+0 with 60s delay
    queue.enqueue(makeEvent("key-1", "unaddressed", 60_000));

    // Mention arrives at T+10s with 3s delay (readyAt = T+13s)
    setTime(BASE_TIME + 10_000);
    queue.enqueue(makeMention("key-1", "hey @thor"));

    // At T+12.999s — not ready (interrupt readyAt = T+13s)
    setTime(BASE_TIME + 12_999);
    await queue.flush();
    expect(handler).not.toHaveBeenCalled();

    // At T+13s — fires. The mention's readyAt controls timing; non-mention swept in.
    setTime(BASE_TIME + 13_000);
    await queue.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    const texts = batchTexts(handler)[0];
    expect(texts).toContain("unaddressed");
    expect(texts).toContain("hey @thor");
  });

  it("S8: mention in thread A while session runs for thread B — independent", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Thread A mention
    queue.enqueue(makeMention("key-a", "mention-A"));
    // Thread B mention
    queue.enqueue(makeMention("key-b", "mention-B"));

    setTime(BASE_TIME + 3_000);
    await queue.flush();

    // Both fire independently
    expect(handler).toHaveBeenCalledTimes(2);
    const keys = handler.mock.calls.map((c: [QueuedEvent[]]) => c[0][0].correlationKey).sort();
    expect(keys).toEqual(["key-a", "key-b"]);
  });

  // ---------------------------------------------------------------------------
  // Interrupt readyAt behavior
  // ---------------------------------------------------------------------------

  it("interrupt events still debounce on their own readyAt", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeMention("key-1", "mention", 60_000));

    await queue.flush();
    expect(handler).not.toHaveBeenCalled();

    // File still in queue
    const remaining = readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(1);
  });

  it("interrupt events ignore non-interrupt readyAt when deciding batch readiness", async () => {
    const handler = vi.fn<(events: QueuedEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    // Non-interrupt with readyAt far in the future
    queue.enqueue(makeEvent("key-1", "unaddressed", 60_000));

    // Interrupt that is ready now
    queue.enqueue({
      id: `test-${++eventSeq}`,
      source: "slack",
      correlationKey: "key-1",
      payload: { text: "mention" },
      receivedAt: new Date().toISOString(),
      sourceTs: now,
      readyAt: 0,
      delayMs: 0,
      interrupt: true,
    });

    await queue.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toHaveLength(2);
  });

  it("non-interrupt events wait while key is processing", async () => {
    const batches: string[][] = [];
    let resolveFirst: (() => void) | null = null;

    const handler = vi
      .fn<(events: QueuedEvent[]) => Promise<void>>()
      .mockImplementation(async (events) => {
        const texts = events.map((e) => (e.payload as { text: string }).text);
        if (texts[0] === "first") {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        batches.push(texts);
      });

    queue = new EventQueue({ dir: queueDir, handler, disableInterval: true });

    queue.enqueue(makeEvent("key-1", "first"));
    const flushPromise = queue.flush();

    await new Promise((r) => setTimeout(r, 50));

    queue.enqueue(makeEvent("key-1", "non-interrupt"));

    resolveFirst!();
    await flushPromise;

    expect(batches).toEqual([["first"], ["non-interrupt"]]);
  });
});
