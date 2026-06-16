/**
 * Process-owned SSE event bus for OpenCode.
 *
 * Owns one global OpenCode SSE connection per base URL. Subscriptions register
 * interest by session id and receive matching events. Firehose observers
 * receive every decoded event regardless of session id.
 *
 * - Starts on the first subscribe() call (or via explicit start()).
 * - Reconnects automatically whenever the stream ends.
 * - Subscription close does not affect SSE connection lifetime.
 * - Observer exceptions are caught and logged so they cannot kill the reader.
 */

import { createOpencodeClient, type Event, type GlobalEvent } from "@opencode-ai/sdk";
import { EventEmitter } from "node:events";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("event-bus");

/**
 * Minimum delay between reconnect attempts. Guards against a tight loop if
 * opencode's SSE endpoint closes immediately.
 */
const RECONNECT_MIN_DELAY_MS = 1000;

/** Receives every decoded event from the global SSE stream. */
export type FirehoseObserver = (event: Event, sessionId: string | undefined) => void;

/**
 * One global SSE connection. Dispatches events to per-session listeners and
 * firehose observers. Process-owned: connection lifetime is independent of
 * subscription count.
 */
class GlobalEventBus {
  private emitter = new EventEmitter();
  private alive = false;
  private started = false;
  private connectPromise: Promise<void> | null = null;
  private activeSubscriptions = 0;
  private connectionGeneration = 0;
  private currentClient: unknown = null;
  private currentStream: unknown = null;
  private currentIterator: AsyncIterator<GlobalEvent> | null = null;
  private currentAbortController: AbortController | null = null;
  private closed = false;
  private baseUrl: string;
  private lastConnectAt = 0;
  private pendingReconnect: ReturnType<typeof setTimeout> | null = null;
  private firehoseObservers = new Set<FirehoseObserver>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    // Sessions can be numerous; raise the per-event limit.
    this.emitter.setMaxListeners(200);
  }

  /**
   * Mark the bus as started and initiate the connection. Idempotent.
   * Called by subscribe() and by EventBusRegistry.start() when a
   * ProgressListener is registered.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.ensureConnected().catch((err) => {
      logError(log, "start_error", err instanceof Error ? err.message : String(err), {
        baseUrl: this.baseUrl,
      });
    });
  }

  addFirehoseObserver(observer: FirehoseObserver): void {
    this.firehoseObservers.add(observer);
  }

  removeFirehoseObserver(observer: FirehoseObserver): void {
    this.firehoseObservers.delete(observer);
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
    this.lastConnectAt = Date.now();
    logInfo(log, "connected", { baseUrl: this.baseUrl });

    // Fire-and-forget reader loop. When the stream ends, reconnect if started.
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
          // Deliver to firehose observers; catch exceptions so they cannot kill
          // the reader loop.
          for (const observer of this.firehoseObservers) {
            try {
              observer(event.payload, sid);
            } catch (err) {
              logError(
                log,
                "firehose_observer_error",
                err instanceof Error ? err.message : String(err),
              );
            }
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
          this.reconnect();
        }
      }
    })();
  }

  subscribe(sessionIds: string[]): SessionSubscription {
    if (this.closed) throw new Error("GlobalEventBus is closed");
    // Ensure the bus is started so it reconnects independently of subscription
    // count — first subscriber makes the bus persistent for the process lifetime.
    this.start();
    this.activeSubscriptions++;
    return new SessionSubscription(this.emitter, sessionIds, () => this.releaseSubscription());
  }

  private releaseSubscription(): void {
    if (this.activeSubscriptions > 0) {
      this.activeSubscriptions--;
    }
    // Bus lifetime is process-owned: no onEmpty or disposal on last close.
  }

  private reconnect(): void {
    if (this.closed || !this.started) return;
    if (this.pendingReconnect || this.connectPromise) return;
    const elapsed = Date.now() - this.lastConnectAt;
    const delay = elapsed >= RECONNECT_MIN_DELAY_MS ? 0 : RECONNECT_MIN_DELAY_MS - elapsed;
    const runReconnect = () => {
      this.pendingReconnect = null;
      if (this.closed || !this.started || this.alive) return;
      void this.ensureConnected().catch((err) => {
        logError(log, "reconnect_error", err instanceof Error ? err.message : String(err), {
          baseUrl: this.baseUrl,
        });
      });
    };
    if (delay === 0) {
      runReconnect();
    } else {
      this.pendingReconnect = setTimeout(runReconnect, delay);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.alive = false;
    this.connectPromise = null;
    this.connectionGeneration++;
    if (this.pendingReconnect) {
      clearTimeout(this.pendingReconnect);
      this.pendingReconnect = null;
    }
    const abortController = this.currentAbortController;
    const iterator = this.currentIterator;
    const stream = this.currentStream;
    const client = this.currentClient;
    this.currentAbortController = null;
    this.currentIterator = null;
    this.currentStream = null;
    this.currentClient = null;
    this.emitter.removeAllListeners();
    this.firehoseObservers.clear();
    abortController?.abort();
    void closeSseResource(iterator);
    if (stream !== iterator) void closeSseResource(stream);
    if (client !== stream && client !== iterator) void closeSseResource(client);
  }
}

/**
 * Registry that hands out one global event bus per OpenCode base URL.
 * The bus is process-owned: it stays alive after all subscriptions close.
 */
export class EventBusRegistry {
  private bus: GlobalEventBus | undefined;
  private baseUrl: string;
  private observers = new Set<FirehoseObserver>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Add a firehose observer that receives every decoded event. Registered
   * immediately on the existing bus (if any) and on any future bus creation.
   */
  addFirehoseObserver(observer: FirehoseObserver): void {
    this.observers.add(observer);
    this.bus?.addFirehoseObserver(observer);
  }

  /**
   * Explicitly start the bus (called by ProgressListener setup). Idempotent.
   */
  start(): void {
    this.getOrCreateBus().start();
  }

  /**
   * Get a subscription for the given session IDs. Creates the bus lazily on
   * first use and ensures it is started.
   */
  async subscribe(sessionIds: string[]): Promise<SessionSubscription> {
    const bus = this.getOrCreateBus();
    const subscription = bus.subscribe(sessionIds);
    try {
      await bus.ensureConnected();
      return subscription;
    } catch (err) {
      subscription.close();
      throw err;
    }
  }

  private getOrCreateBus(): GlobalEventBus {
    if (!this.bus) {
      this.bus = new GlobalEventBus(this.baseUrl);
      for (const observer of this.observers) {
        this.bus.addFirehoseObserver(observer);
      }
    }
    return this.bus;
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
  if (event.type === "message.updated") {
    // Align with prompt-stream.ts: check properties.info ?? properties.message
    const properties = (event as unknown as { properties?: Record<string, unknown> }).properties;
    const info = (properties?.info ?? properties?.message) as
      | { sessionID?: string; sessionId?: string }
      | undefined;
    return info?.sessionID ?? info?.sessionId;
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
