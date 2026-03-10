/**
 * Directory-based event queue with per-key serial processing.
 *
 * Incoming events are written as individual JSON files to a queue directory.
 * A fixed-interval consumer scans the directory, groups pending files by
 * correlation key, and dispatches each group as a batch to the handler once
 * the batch's readyAt deadline has passed.
 *
 * No events are dropped — the handler receives all queued events for a key
 * in chronological order and decides how to process them (e.g. combine
 * prompts into a single runner trigger).
 *
 * Flow:
 *   1. HTTP handler calls enqueue() → atomic file write (.tmp → rename).
 *   2. Fixed-interval scan (default 100ms) reads the directory.
 *   3. Group files by correlation key; check max(readyAt) per group.
 *   4. If readyAt <= now → dispatch the batch. If not → skip (wait for next tick).
 *   5. Per-key serial: if a key is already processing, skip it (files stay).
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { createLogger, logError, logInfo } from "@thor/common";

const log = createLogger("event-queue");

export interface QueuedEvent<T = unknown> {
  /** Unique event ID for dedup (e.g. Slack event_id). Retries with the same ID overwrite the file. */
  id: string;
  source: string;
  correlationKey: string;
  payload: T;
  receivedAt: string;
  /** Source-authoritative timestamp in epoch ms (e.g. parsed from Slack ts). Falls back to Date.now(). */
  sourceTs?: number;
  /** Epoch ms after which this event's batch is eligible for processing. */
  readyAt: number;
}

const QueuedEventSchema = z.object({
  id: z.string(),
  source: z.string(),
  correlationKey: z.string(),
  payload: z.unknown(),
  receivedAt: z.string(),
  sourceTs: z.number().optional(),
  readyAt: z.number(),
});

export type EventHandler = (events: QueuedEvent[]) => Promise<void>;

export interface EventQueueOptions {
  /** Queue directory path. Created if it doesn't exist. */
  dir: string;
  /** Callback invoked with all queued events for a key (chronological order). */
  handler: EventHandler;
  /** Scan interval in milliseconds. Default: 100. */
  intervalMs?: number;
  /** Disable the polling interval (for tests that use flush()). Default: false. */
  disableInterval?: boolean;
}

export class EventQueue {
  private readonly dir: string;
  private readonly handler: EventHandler;

  /** Correlation keys with in-flight processing. */
  private readonly processing = new Set<string>();
  /** Tracked promises for in-flight processing (for flush). */
  private readonly active = new Set<Promise<void>>();

  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: EventQueueOptions) {
    this.dir = options.dir;
    this.handler = options.handler;

    mkdirSync(this.dir, { recursive: true });

    if (!options.disableInterval) {
      this.interval = setInterval(() => this.scan(), options.intervalMs ?? 100);
    }
  }

  /** Write an event to the queue directory (synchronous, atomic). */
  enqueue(event: QueuedEvent): void {
    const ts = (event.sourceTs ?? Date.now()).toString().padStart(15, "0");
    const filename = `${ts}_${event.id}.json`;
    const tmpPath = join(this.dir, `.${filename}.tmp`);
    const finalPath = join(this.dir, filename);

    writeFileSync(tmpPath, JSON.stringify(event), "utf8");
    renameSync(tmpPath, finalPath);

    logInfo(log, "event_enqueued", {
      source: event.source,
      correlationKey: event.correlationKey,
    });
  }

  /**
   * Manually scan the queue, process all ready events, and wait for
   * all in-flight processing to complete. Repeats until the queue is empty.
   *
   * Intended for tests (bypasses the polling interval).
   */
  async flush(): Promise<void> {
    for (;;) {
      this.scan();

      if (this.active.size === 0) break;
      await Promise.allSettled([...this.active]);
    }
  }

  /** Stop the polling interval. */
  close(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Read all pending event files, group by correlation key, and dispatch
   * each ready group as a batch to the handler.
   */
  private scan(): void {
    if (this.active.size > 0) return;

    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .sort();
    } catch {
      return;
    }

    if (files.length === 0) return;

    const now = Date.now();
    const byKey = new Map<string, Array<{ file: string; event: QueuedEvent }>>();

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf8");
        const event = QueuedEventSchema.parse(JSON.parse(raw));
        const key = event.correlationKey;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push({ file, event });
      } catch {
        // Corrupt or partially written file — remove it.
        try {
          unlinkSync(join(this.dir, file));
        } catch {}
      }
    }

    for (const [key, entries] of byKey) {
      if (this.processing.has(key)) continue;

      // Check if the batch is ready: max(readyAt) must be <= now.
      const maxReadyAt = Math.max(...entries.map((e) => e.event.readyAt));
      if (maxReadyAt > now) continue;

      this.processing.add(key);

      const work = this.processBatch(key, entries);
      this.active.add(work);
      void work.finally(() => this.active.delete(work));
    }
  }

  /** Process a batch of events for a single key: delete files, invoke handler, re-scan. */
  private async processBatch(
    key: string,
    entries: Array<{ file: string; event: QueuedEvent }>,
  ): Promise<void> {
    try {
      // Delete all files before processing (at-most-once delivery).
      for (const { file } of entries) {
        try {
          unlinkSync(join(this.dir, file));
        } catch {}
      }

      logInfo(log, "event_processing", {
        correlationKey: key,
        count: entries.length,
        source: entries[0].event.source,
      });

      await this.handler(entries.map((e) => e.event));

      logInfo(log, "event_completed", { correlationKey: key });
    } catch (err) {
      logError(log, "event_handler_error", err, { correlationKey: key });
    } finally {
      this.processing.delete(key);
    }
  }
}
