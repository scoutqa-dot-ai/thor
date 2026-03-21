/**
 * Directory-based event queue with debounced batching.
 *
 * See docs/plan/2026032101_mention-interrupt.md for design details.
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
  /** Source-authoritative timestamp in epoch ms (e.g. parsed from Slack ts). */
  sourceTs: number;
  /** Epoch ms after which this event's batch is eligible for processing. */
  readyAt: number;
  /** Original delay in ms used to compute readyAt. */
  delayMs?: number;
  /** If true, this event can interrupt a running session for the same key. */
  interrupt?: boolean;
}

const QueuedEventSchema = z.object({
  id: z.string(),
  source: z.string(),
  correlationKey: z.string(),
  payload: z.unknown(),
  receivedAt: z.string(),
  sourceTs: z.number(),
  readyAt: z.number(),
  delayMs: z.number().optional(),
  interrupt: z.boolean().optional(),
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

  /** Per-key in-flight promise. Prevents the same key from dispatching twice in one cycle. */
  private readonly processing = new Map<string, Promise<void>>();

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
    const ts = event.sourceTs.toString().padStart(15, "0");
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

      if (this.processing.size === 0) break;
      await Promise.allSettled([...this.processing.values()]);
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

  private scan(): void {
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

      // When interrupt events exist, readiness is based on interrupt events only
      // (non-interrupt events get swept in but don't delay the batch).
      const interruptEntries = entries.filter((e) => e.event.interrupt);
      const readyAtSource = interruptEntries.length > 0 ? interruptEntries : entries;
      const maxReadyAt = Math.max(...readyAtSource.map((e) => e.event.readyAt));
      if (maxReadyAt > now) continue;

      const work = this.processBatch(key, entries);
      this.processing.set(key, work);
    }
  }

  private async processBatch(
    key: string,
    entries: Array<{ file: string; event: QueuedEvent }>,
  ): Promise<void> {
    try {
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
