/**
 * Lazy shared SSE event bus for OpenCode.
 *
 * Instead of each trigger opening its own SSE connection, all triggers share
 * one global OpenCode event stream. Subscriptions register interest by session
 * id, and the global stream dispatches matching payloads to per-session listeners.
 *
 * - Connects lazily on the first subscribe() call.
 * - If the stream ends while subscriptions are active, reconnects immediately.
 * - Listeners are cleaned up when the returned iterator is broken/returned.
 */

import { createOpencodeClient, type Event, type GlobalEvent } from "@opencode-ai/sdk";
import { EventEmitter } from "node:events";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("event-bus");

/**
 * One global SSE connection. Dispatches events to session listeners.
 */
class GlobalEventBus {
  private emitter = new EventEmitter();
  private alive = false;
  private connectPromise: Promise<void> | null = null;
  private activeSubscriptions = 0;
  private connectionGeneration = 0;
  private currentClient: unknown = null;
  private currentStream: unknown = null;
  private currentIterator: AsyncIterator<GlobalEvent> | null = null;
  private currentAbortController: AbortController | null = null;
  private closed = false;
  private baseUrl: string;
  private onEmpty: () => void;

  constructor(baseUrl: string, onEmpty: () => void) {
    this.baseUrl = baseUrl;
    this.onEmpty = onEmpty;
    // Sessions can be numerous; raise the per-event limit.
    this.emitter.setMaxListeners(200);
  }

  /**
   * Ensure the SSE connection is up. Multiple callers share the same promise
   * until it resolves, so only one connection attempt happens at a time.
   */
  ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("GlobalEventBus is closed"));
    if (this.alive) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    const abortController = new AbortController();
    const client = createOpencodeClient({
      baseUrl: this.baseUrl,
    });

    const { stream } = await client.global.event({ signal: abortController.signal });
    if (this.closed || generation !== this.connectionGeneration) {
      abortController.abort();
      await closeSseResource(stream);
      await closeSseResource(client);
      return;
    }

    this.currentClient = client;
    this.currentStream = stream;
    this.currentAbortController = abortController;
    this.alive = true;
    logInfo(log, "connected", { baseUrl: this.baseUrl });

    // Fire-and-forget reader loop. When the stream ends, active subscriptions
    // trigger an immediate reconnect through ensureConnected().
    void (async () => {
      const iterator = stream[Symbol.asyncIterator]();
      if (generation === this.connectionGeneration) {
        this.currentIterator = iterator;
      }
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          const sid = extractSessionId(event.payload);
          if (sid) {
            this.emitter.emit(sid, event.payload);
          }
        }
      } catch (err) {
        logError(log, "stream_error", err instanceof Error ? err.message : String(err), {
          baseUrl: this.baseUrl,
        });
      } finally {
        if (generation === this.connectionGeneration) {
          this.alive = false;
          this.currentClient = null;
          this.currentStream = null;
          this.currentIterator = null;
          this.currentAbortController = null;
          logInfo(log, "disconnected", { baseUrl: this.baseUrl });
          this.reconnectIfActive();
        }
      }
    })();
  }

  subscribe(sessionIds: string[]): SessionSubscription {
    if (this.closed) throw new Error("GlobalEventBus is closed");
    this.activeSubscriptions++;
    return new SessionSubscription(this.emitter, sessionIds, () => this.releaseSubscription());
  }

  private releaseSubscription(): void {
    if (this.activeSubscriptions > 0) {
      this.activeSubscriptions--;
    }
    if (this.activeSubscriptions === 0) {
      this.onEmpty();
    }
  }

  private reconnectIfActive(): void {
    if (this.closed || this.activeSubscriptions === 0) return;
    void this.ensureConnected().catch((err) => {
      logError(log, "reconnect_error", err instanceof Error ? err.message : String(err), {
        baseUrl: this.baseUrl,
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeSubscriptions = 0;
    this.alive = false;
    this.connectPromise = null;
    this.connectionGeneration++;
    const abortController = this.currentAbortController;
    const iterator = this.currentIterator;
    const stream = this.currentStream;
    const client = this.currentClient;
    this.currentAbortController = null;
    this.currentIterator = null;
    this.currentStream = null;
    this.currentClient = null;
    this.emitter.removeAllListeners();
    abortController?.abort();
    void closeSseResource(iterator);
    if (stream !== iterator) void closeSseResource(stream);
    if (client !== stream && client !== iterator) void closeSseResource(client);
  }
}

/**
 * Registry that hands out one global event bus per OpenCode base URL.
 */
export class EventBusRegistry {
  private bus: GlobalEventBus | undefined;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Get a subscription for the given session IDs. Creates the bus lazily on
   * first use; reconnects if the previous connection died.
   */
  async subscribe(sessionIds: string[]): Promise<SessionSubscription> {
    let bus = this.bus;
    if (!bus) {
      const createdBus = new GlobalEventBus(this.baseUrl, () => {
        if (this.bus === createdBus) {
          this.bus = undefined;
          createdBus.close();
        }
      });
      bus = createdBus;
      this.bus = bus;
    }
    const subscription = bus.subscribe(sessionIds);
    try {
      await bus.ensureConnected();
      return subscription;
    } catch (err) {
      subscription.close();
      throw err;
    }
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
  private onClose: (() => void) | undefined;
  private handler = (event: Event) => {
    this.queue.push(event);
    this.waiter?.();
  };

  constructor(emitter: EventEmitter, sessionIds: string[], onClose?: () => void) {
    this.emitter = emitter;
    this.sessionIds = new Set(sessionIds);
    this.onClose = onClose;
    for (const sid of this.sessionIds) {
      this.emitter.on(sid, this.handler);
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
    this.onClose?.();
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

/**
 * Wait for a session to reach a terminal state, with a hard timeout.
 * Resolves `true` if settled, `false` on timeout or subscription end.
 *
 * Terminal events:
 *   - `session.idle`  — session completed successfully (no error)
 *   - `session.error` — session errored out (including after abort)
 */
export async function waitForSessionSettled(
  sub: AsyncIterable<Event>,
  timeoutMs: number,
): Promise<boolean> {
  const waitForSettled = (async () => {
    for await (const event of sub) {
      if (event.type === "session.idle" || event.type === "session.error") return true;
    }
    return false;
  })();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForSettled,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeSseResource(resource: unknown): Promise<void> {
  if (!resource || typeof resource !== "object") return;
  for (const method of ["return", "abort", "cancel", "close"] as const) {
    const fn = (resource as Record<string, unknown>)[method];
    if (typeof fn === "function") {
      try {
        await fn.call(resource);
      } catch (err) {
        logError(log, "close_resource_error", err instanceof Error ? err.message : String(err));
      }
      return;
    }
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
