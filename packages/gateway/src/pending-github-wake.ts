import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger, logError, logInfo, resolveCorrelationLockKey } from "@thor/common";
import { z } from "zod/v4";
import type { QueuedEvent } from "./queue.js";
import type { GitHubWebhookEvent } from "./github.js";

const log = createLogger("pending-github-wake");

export type PendingGitHubWakeResult = "accepted" | "busy" | "rejected";

export interface PendingGitHubWakeOptions {
  dir: string;
  handler: (events: QueuedEvent<GitHubWebhookEvent>[]) => Promise<PendingGitHubWakeResult>;
  intervalMs?: number;
  retryDelayMs?: number;
  disableInterval?: boolean;
}

const PendingWakeSchema = z.object({
  lockKey: z.string(),
  nextAttemptAt: z.number(),
  events: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      correlationKey: z.string(),
      payload: z.unknown(),
      receivedAt: z.string(),
      sourceTs: z.number(),
      readyAt: z.number(),
      delayMs: z.number().optional(),
      interrupt: z.boolean().optional(),
    }),
  ),
});

type PendingWake = z.infer<typeof PendingWakeSchema>;

function compareEvents(a: QueuedEvent, b: QueuedEvent): number {
  return a.sourceTs - b.sourceTs || a.id.localeCompare(b.id);
}

function filenameForLockKey(lockKey: string): string {
  return `${Buffer.from(lockKey, "utf8").toString("base64url")}.json`;
}

export class PendingGitHubWakeQueue {
  private readonly dir: string;
  private readonly handler: PendingGitHubWakeOptions["handler"];
  private readonly retryDelayMs: number;
  private readonly processing = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: PendingGitHubWakeOptions) {
    this.dir = options.dir;
    this.handler = options.handler;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
    mkdirSync(this.dir, { recursive: true });
    if (!options.disableInterval) {
      this.interval = setInterval(() => this.scan(), options.intervalMs ?? 1000);
    }
  }

  has(correlationKey: string): boolean {
    const lockKey = resolveCorrelationLockKey(correlationKey);
    return this.read(lockKey) !== undefined;
  }

  park(events: QueuedEvent<GitHubWebhookEvent>[]): void {
    if (events.length === 0) return;
    const lockKey = resolveCorrelationLockKey(events[events.length - 1].correlationKey);
    const existing = this.read(lockKey);
    const byId = new Map<string, QueuedEvent<GitHubWebhookEvent>>();
    for (const event of existing?.events ?? [])
      byId.set(event.id, event as QueuedEvent<GitHubWebhookEvent>);
    for (const event of events) byId.set(event.id, event);
    const merged = [...byId.values()].sort(compareEvents);
    this.write({
      lockKey,
      nextAttemptAt: existing?.nextAttemptAt ?? Date.now() + this.retryDelayMs,
      events: merged,
    });
    logInfo(log, "github_pending_wake_parked", { lockKey, count: merged.length });
  }

  async flush(): Promise<void> {
    await this.scan(true);
  }

  close(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async scan(force = false): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter(
        (file) => file.endsWith(".json") && !file.startsWith("."),
      );
    } catch {
      return;
    }
    const now = Date.now();
    await Promise.all(
      files.map(async (file) => {
        const wake = this.readFile(file);
        if (!wake || this.processing.has(wake.lockKey)) return;
        if (!force && wake.nextAttemptAt > now) return;
        this.processing.add(wake.lockKey);
        const replayedIds = new Set(wake.events.map((event) => event.id));
        try {
          const result = await this.handler(wake.events as QueuedEvent<GitHubWebhookEvent>[]);
          const current = this.read(wake.lockKey) ?? wake;
          if (result === "busy") {
            this.write({ ...current, nextAttemptAt: Date.now() + this.retryDelayMs });
          } else {
            const remaining = current.events.filter((event) => !replayedIds.has(event.id));
            if (remaining.length === 0) {
              this.delete(wake.lockKey);
            } else {
              this.write({
                ...current,
                nextAttemptAt: Date.now() + this.retryDelayMs,
                events: remaining,
              });
            }
          }
        } catch (error) {
          logError(log, "github_pending_wake_error", error, { lockKey: wake.lockKey });
          this.write({
            ...(this.read(wake.lockKey) ?? wake),
            nextAttemptAt: Date.now() + this.retryDelayMs,
          });
        } finally {
          this.processing.delete(wake.lockKey);
        }
      }),
    );
  }

  private read(lockKey: string): PendingWake | undefined {
    return this.readFile(filenameForLockKey(lockKey));
  }

  private readFile(file: string): PendingWake | undefined {
    try {
      return PendingWakeSchema.parse(JSON.parse(readFileSync(join(this.dir, file), "utf8")));
    } catch {
      return undefined;
    }
  }

  private write(wake: PendingWake): void {
    const file = filenameForLockKey(wake.lockKey);
    const tmp = join(this.dir, `.${file}.tmp`);
    writeFileSync(tmp, JSON.stringify(wake), "utf8");
    renameSync(tmp, join(this.dir, file));
  }

  private delete(lockKey: string): void {
    try {
      unlinkSync(join(this.dir, filenameForLockKey(lockKey)));
    } catch {}
  }
}
