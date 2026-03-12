import { createLogger, logInfo, logError } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import { postMessage, updateMessage, deleteMessage, type SlackDeps } from "./slack.js";

const log = createLogger("slack-progress");

/** Threshold: post first message after this many tool calls. */
const TOOL_CALL_THRESHOLD = 3;
/** Minimum interval between Slack message updates (ms). */
const UPDATE_INTERVAL_MS = 10_000;
/** How long to wait for the bot's own reply before keeping the progress message (ms). */
const CLEANUP_TIMEOUT_MS = 60_000;

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

// ---------------------------------------------------------------------------
// Progress session — one per thread, equivalent to old SlackNotifier
// ---------------------------------------------------------------------------

class ProgressSession {
  private channel: string;
  private threadTs: string;
  private deps: SlackDeps;

  private messageTs?: string;
  private toolCallCount = 0;
  private lastTools: string[] = [];
  private startTime: number;
  private lastUpdateTime = 0;
  private thresholdMet = false;
  private finished = false;

  constructor(channel: string, threadTs: string, deps: SlackDeps) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.deps = deps;
    this.startTime = Date.now();
  }

  async onToolCall(toolName: string): Promise<void> {
    if (this.finished) return;

    this.toolCallCount++;
    this.lastTools = [...this.lastTools.slice(-2), toolName];

    if (!this.thresholdMet) {
      if (this.toolCallCount >= TOOL_CALL_THRESHOLD) {
        this.thresholdMet = true;
        await this.flush();
      }
      return;
    }

    if (Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS) {
      await this.flush();
    }
  }

  async finish(status: "completed" | "error", errorMsg?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    if (!this.thresholdMet) return;

    const elapsed = formatDuration(Date.now() - this.startTime);

    if (status === "completed") {
      const text = `✅ Done — ${this.toolCallCount} tool calls in ${elapsed}`;
      if (this.messageTs) {
        await this.update(text);
      } else {
        await this.post(text);
      }
      if (this.messageTs) {
        pendingCleanups.register(this.channel, this.threadTs, this.messageTs, this.deps);
      }
      return;
    }

    const text = `❌ Failed — ${errorMsg || "session error"} after ${this.toolCallCount} tool calls`;
    if (this.messageTs) {
      await this.update(text);
    } else {
      await this.post(text);
    }
  }

  private async flush(): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const toolSuffix = this.lastTools.length > 0 ? ` | last: ${this.lastTools.join(", ")}` : "";
    const text = `⏳ Working... ${this.toolCallCount} tool calls | ${elapsed} elapsed${toolSuffix}`;

    if (this.messageTs) {
      await this.update(text);
    } else {
      await this.post(text);
    }

    this.lastUpdateTime = Date.now();
  }

  private async post(text: string): Promise<void> {
    try {
      const result = await postMessage(this.channel, text, this.threadTs, this.deps);
      this.messageTs = result.ts;
      logInfo(log, "progress_posted", { channel: this.channel, ts: this.messageTs });
    } catch (err) {
      logError(log, "post_error", err instanceof Error ? err.message : String(err));
    }
  }

  private async update(text: string): Promise<void> {
    if (!this.messageTs) return;
    try {
      await updateMessage(this.channel, this.messageTs, text, this.deps);
    } catch (err) {
      logError(log, "update_error", err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Active sessions registry
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, ProgressSession>();

/**
 * Handle a progress event for a specific thread.
 * Creates/reuses a ProgressSession per channel+threadTs.
 */
export async function handleProgressEvent(
  channel: string,
  threadTs: string,
  event: ProgressEvent,
  deps: SlackDeps,
): Promise<void> {
  const key = threadKey(channel, threadTs);

  if (event.type === "start") {
    // New session — replace any existing one
    activeSessions.set(key, new ProgressSession(channel, threadTs, deps));
    return;
  }

  let session = activeSessions.get(key);
  if (!session) {
    // Late-arriving event without start — create session on the fly
    session = new ProgressSession(channel, threadTs, deps);
    activeSessions.set(key, session);
  }

  switch (event.type) {
    case "tool":
      await session.onToolCall(event.tool);
      break;
    case "done":
      await session.finish(event.status === "completed" ? "completed" : "error", event.error);
      activeSessions.delete(key);
      break;
    case "error":
      await session.finish("error", event.error);
      activeSessions.delete(key);
      break;
  }
}

// ---------------------------------------------------------------------------
// Pending cleanup registry — tracks done messages waiting for bot reply
// ---------------------------------------------------------------------------

interface PendingEntry {
  channel: string;
  threadTs: string;
  messageTs: string;
  deps: SlackDeps;
  timer: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, PendingEntry>();

export const pendingCleanups = {
  register(channel: string, threadTs: string, messageTs: string, deps: SlackDeps): void {
    const key = threadKey(channel, threadTs);

    const existing = registry.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      registry.delete(key);
      logInfo(log, "cleanup_expired", { channel, threadTs, messageTs });
    }, CLEANUP_TIMEOUT_MS);

    registry.set(key, { channel, threadTs, messageTs, deps, timer });
  },

  async onBotReply(channel: string, threadTs: string): Promise<void> {
    const key = threadKey(channel, threadTs);
    const entry = registry.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    registry.delete(key);

    try {
      await deleteMessage(entry.channel, entry.messageTs, entry.deps);
      logInfo(log, "progress_deleted", {
        channel: entry.channel,
        ts: entry.messageTs,
        threadTs: entry.threadTs,
      });
    } catch (err) {
      logError(log, "delete_error", err instanceof Error ? err.message : String(err));
    }
  },

  get size(): number {
    return registry.size;
  },

  clear(): void {
    for (const entry of registry.values()) {
      clearTimeout(entry.timer);
    }
    registry.clear();
    activeSessions.clear();
  },
};
