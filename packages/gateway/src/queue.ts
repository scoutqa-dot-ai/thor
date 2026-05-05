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
import {
  createLogger,
  ensureAnchorForCorrelationKey,
  logError,
  logInfo,
  resolveCorrelationLockKey,
} from "@thor/common";

const log = createLogger("event-queue");

function compareEvents(
  a: { sourceTs: number; id: string },
  b: { sourceTs: number; id: string },
): number {
  return a.sourceTs - b.sourceTs || a.id.localeCompare(b.id);
}

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

/**
 * Handler callback. Call `ack()` to confirm processing and delete the files.
 * Call `reject(reason)` to move files to the dead-letter directory.
 * If the handler returns without calling ack or reject (e.g. runner busy),
 * files stay on disk and will be retried on the next scan cycle.
 * If the handler throws, files are deleted to prevent infinite retry loops.
 */
export type EventHandler = (
  events: QueuedEvent[],
  ack: () => void,
  reject: (reason: string) => void,
) => Promise<void>;

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

export interface PendingQueueEventSnapshot {
  id: string;
  source: string;
  correlationKey: string;
  receivedAt: string;
  sourceTs: number;
  readyAt: number;
  delayMs?: number;
  interrupt?: boolean;
}

export interface PendingQueueSnapshot {
  pending: PendingQueueEventSnapshot[];
  pendingCount: number;
  readError?: string;
}

export class EventQueue {
  private readonly dir: string;
  private readonly deadLetterDir: string;
  private readonly handler: EventHandler;

  /** Per-lock-key in-flight promise. Prevents one session/key from dispatching twice in one cycle. */
  private readonly processing = new Map<string, Promise<void>>();
  /** Incremented each time a handler calls ack or reject. Used by flush() to detect progress. */
  private ackCount = 0;

  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: EventQueueOptions) {
    this.dir = options.dir;
    this.deadLetterDir = join(this.dir, "dead-letter");
    this.handler = options.handler;

    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.deadLetterDir, { recursive: true });

    if (!options.disableInterval) {
      this.interval = setInterval(() => this.scan(), options.intervalMs ?? 100);
    }
  }

  /** Pre-bind a supported correlation anchor, then write an event atomically. */
  async enqueue(event: QueuedEvent): Promise<void> {
    const bound = await ensureAnchorForCorrelationKey(event.correlationKey);
    const ts = event.sourceTs.toString().padStart(15, "0");
    const filename = `${ts}_${event.id}.json`;
    const tmpPath = join(this.dir, `.${filename}.tmp`);
    const finalPath = join(this.dir, filename);

    writeFileSync(tmpPath, JSON.stringify(event), "utf8");
    renameSync(tmpPath, finalPath);

    logInfo(log, "event_enqueued", {
      source: event.source,
      correlationKey: event.correlationKey,
      ...(bound.anchorId ? { anchorId: bound.anchorId, anchorMinted: bound.minted } : {}),
    });
  }

  /**
   * Manually scan the queue, process all ready events, and wait for
   * all in-flight processing to complete. Repeats while handlers keep
   * acking (new files get deleted → new events may become ready).
   * Stops when no handler acks in a cycle (deferred events stay on disk).
   *
   * Intended for tests (bypasses the polling interval).
   */
  async flush(): Promise<void> {
    for (;;) {
      this.scan();

      if (this.processing.size === 0) break;

      const acksBefore = this.ackCount;
      await Promise.allSettled([...this.processing.values()]);

      // If no handler acked in this cycle, remaining files are deferred — stop.
      if (this.ackCount === acksBefore) break;
    }
  }

  /** Stop the polling interval. */
  close(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Read-only snapshot of current live pending events (no payloads). */
  snapshotPending(): PendingQueueSnapshot {
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith(".") && f !== "dead-letter")
        .sort();
    } catch (error) {
      return {
        pending: [],
        pendingCount: 0,
        readError: error instanceof Error ? error.message : String(error),
      };
    }

    const pending: PendingQueueEventSnapshot[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf8");
        const event = QueuedEventSchema.parse(JSON.parse(raw));
        pending.push({
          id: event.id,
          source: event.source,
          correlationKey: event.correlationKey,
          receivedAt: event.receivedAt,
          sourceTs: event.sourceTs,
          readyAt: event.readyAt,
          ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
          ...(event.interrupt !== undefined ? { interrupt: event.interrupt } : {}),
        });
      } catch {
        // Ignore unreadable/corrupt files for snapshot purposes.
      }
    }
    pending.sort(compareEvents);

    return {
      pending,
      pendingCount: pending.length,
    };
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
        const key = resolveCorrelationLockKey(event.correlationKey);
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
      entries.sort((a, b) => compareEvents(a.event, b.event));

      // When interrupt events exist, readiness is based on interrupt events only
      // (non-interrupt events get swept in but don't delay the batch).
      const interruptEntries = entries.filter((e) => e.event.interrupt);
      const readyAtSource = interruptEntries.length > 0 ? interruptEntries : entries;
      const maxReadyAt = Math.max(...readyAtSource.map((e) => e.event.readyAt));
      if (maxReadyAt > now) continue;

      // Set processing before calling processBatch to avoid a race where
      // a sync throw in the handler could delete a not-yet-set key.
      const placeholder = Promise.resolve();
      this.processing.set(key, placeholder);
      const work = this.processBatch(key, entries);
      this.processing.set(key, work);
    }
  }

  private deleteFiles(entries: Array<{ file: string }>): void {
    for (const { file } of entries) {
      try {
        unlinkSync(join(this.dir, file));
      } catch {}
    }
  }

  private moveToDeadLetter(entries: Array<{ file: string }>, reason: string): void {
    for (const { file } of entries) {
      try {
        renameSync(join(this.dir, file), join(this.deadLetterDir, file));
      } catch {}
    }
    logInfo(log, "event_dead_lettered", { count: entries.length, reason });
  }

  private async processBatch(
    lockKey: string,
    entries: Array<{ file: string; event: QueuedEvent }>,
  ): Promise<void> {
    try {
      const correlationKeys = [...new Set(entries.map((entry) => entry.event.correlationKey))];
      const keyMetadata =
        correlationKeys.length === 1 ? { correlationKey: correlationKeys[0] } : { correlationKeys };
      logInfo(log, "event_processing", {
        lockKey,
        ...keyMetadata,
        count: entries.length,
        source: entries[0].event.source,
      });

      let settled = false;
      const ack = () => {
        if (settled) return;
        settled = true;
        this.ackCount++;
        this.deleteFiles(entries);
      };
      const reject = (reason: string) => {
        if (settled) return;
        settled = true;
        this.ackCount++;
        this.moveToDeadLetter(entries, reason);
      };

      await this.handler(
        entries.map((e) => e.event),
        ack,
        reject,
      );

      if (settled) {
        logInfo(log, "event_completed", { lockKey, ...keyMetadata });
      } else {
        logInfo(log, "event_deferred", { lockKey, ...keyMetadata });
      }
    } catch (err) {
      logError(log, "event_handler_error", err, { lockKey });
      // Delete on error to prevent infinite retry loops.
      this.deleteFiles(entries);
    } finally {
      this.processing.delete(lockKey);
    }
  }
}
