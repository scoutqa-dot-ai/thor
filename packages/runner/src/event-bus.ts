/**
 * Lazy shared SSE event bus for OpenCode, keyed by directory.
 *
 * Instead of each trigger opening its own SSE connection and filtering
 * client-side, triggers sharing a directory share one connection that
 * dispatches events to per-session listeners.
 *
 * - Connects lazily on the first subscribe() call per directory.
 * - Does NOT auto-reconnect on failure — the next subscribe() call
 *   will re-establish the connection if needed.
 * - Listeners are cleaned up when the returned iterator is broken/returned.
 */

import { createOpencodeClient, type Event } from "@opencode-ai/sdk";
import { EventEmitter } from "node:events";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("event-bus");

/**
 * One SSE connection per directory. Dispatches events to per-session listeners.
 */
class DirectoryEventBus {
  private emitter = new EventEmitter();
  private alive = false;
  private connectPromise: Promise<void> | null = null;
  private baseUrl: string;
  private directory: string;

  constructor(baseUrl: string, directory: string) {
    this.baseUrl = baseUrl;
    this.directory = directory;
    // Sessions can be numerous; raise the per-event limit.
    this.emitter.setMaxListeners(200);
  }

  /**
   * Ensure the SSE connection is up. Multiple callers share the same promise
   * until it resolves, so only one connection attempt happens at a time.
   */
  ensureConnected(): Promise<void> {
    if (this.alive) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const client = createOpencodeClient({
      baseUrl: this.baseUrl,
      directory: this.directory,
    });

    const { stream } = await client.event.subscribe();
    this.alive = true;
    logInfo(log, "connected", { baseUrl: this.baseUrl, directory: this.directory });

    // Fire-and-forget reader loop. When the stream ends (server close,
    // network error, etc.) we just mark ourselves as dead — the next
    // subscribe() call will reconnect.
    void (async () => {
      try {
        for await (const event of stream) {
          const sid = extractSessionId(event);
          if (sid) {
            this.emitter.emit(sid, event);
          }
        }
      } catch (err) {
        logError(log, "stream_error", err instanceof Error ? err.message : String(err), {
          directory: this.directory,
        });
      } finally {
        this.alive = false;
        logInfo(log, "disconnected", { directory: this.directory });
      }
    })();
  }

  subscribe(sessionIds: string[]): SessionSubscription {
    return new SessionSubscription(this.emitter, sessionIds);
  }
}

/**
 * Registry that hands out one DirectoryEventBus per (baseUrl, directory) pair.
 */
export class EventBusRegistry {
  private buses = new Map<string, DirectoryEventBus>();
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Get a subscription for the given directory and session IDs.
   * Creates the bus lazily on first use; reconnects if the previous
   * connection died.
   */
  async subscribe(directory: string, sessionIds: string[]): Promise<SessionSubscription> {
    let bus = this.buses.get(directory);
    if (!bus) {
      bus = new DirectoryEventBus(this.baseUrl, directory);
      this.buses.set(directory, bus);
    }
    await bus.ensureConnected();
    return bus.subscribe(sessionIds);
  }
}

/**
 * Per-trigger subscription handle. Wraps a buffered queue fed by EventEmitter
 * listeners and exposes an async iterator.
 */
export class SessionSubscription implements AsyncIterable<Event> {
  private emitter: EventEmitter;
  private sessionIds: Set<string>;
  private queue: Event[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private handler = (event: Event) => {
    this.queue.push(event);
    this.waiter?.();
  };

  constructor(emitter: EventEmitter, sessionIds: string[]) {
    this.emitter = emitter;
    this.sessionIds = new Set(sessionIds);
    for (const sid of sessionIds) {
      emitter.on(sid, this.handler);
    }
  }

  /** Start listening to events from an additional session (e.g. child). */
  addSessionId(sid: string): void {
    if (this.done || this.sessionIds.has(sid)) return;
    this.sessionIds.add(sid);
    this.emitter.on(sid, this.handler);
  }

  /** Stop listening and drain. */
  close(): void {
    if (this.done) return;
    this.done = true;
    for (const sid of this.sessionIds) {
      this.emitter.off(sid, this.handler);
    }
    // Wake up any pending next() so it can return done.
    this.waiter?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: async (): Promise<IteratorResult<Event>> => {
        while (this.queue.length === 0) {
          if (this.done) return { value: undefined, done: true };
          await new Promise<void>((resolve) => {
            this.waiter = resolve;
          });
          this.waiter = null;
        }
        return { value: this.queue.shift()!, done: false };
      },
      return: async (): Promise<IteratorResult<Event>> => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

function extractSessionId(event: Event): string | undefined {
  if (event.type === "message.part.updated") {
    return event.properties.part.sessionID;
  }
  if (
    event.type === "session.idle" ||
    event.type === "session.status" ||
    event.type === "session.error"
  ) {
    return event.properties.sessionID;
  }
  return undefined;
}
