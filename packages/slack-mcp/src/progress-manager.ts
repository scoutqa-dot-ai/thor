import { createLogger, logInfo, logError } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import {
  postMessage,
  updateMessage,
  deleteMessage,
  type SlackDeps,
  type SlackBlock,
} from "./slack.js";

const log = createLogger("slack-progress");

/** Threshold: post first message after this many tool calls. */
const TOOL_CALL_THRESHOLD = 3;
/** Minimum interval between Slack message updates (ms). */
const UPDATE_INTERVAL_MS = 10_000;

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

/** A run of consecutive identical tool calls. */
interface ToolGroup {
  name: string;
  count: number;
}

/** Format tool groups for display: [{name:"grep",count:2},{name:"read",count:1}] → "grep x2, read" */
function formatToolGroups(groups: ToolGroup[]): string {
  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name)).join(", ");
}

/** Max characters for a Block Kit mrkdwn text object. */
const BLOCK_TEXT_LIMIT = 3000;

/** Wrap text in a context block for compact, muted rendering in Slack. */
function contextBlocks(text: string): SlackBlock[] {
  const truncated =
    text.length > BLOCK_TEXT_LIMIT ? text.slice(0, BLOCK_TEXT_LIMIT - 1) + "…" : text;
  return [{ type: "context", elements: [{ type: "mrkdwn", text: truncated }] }];
}

// ---------------------------------------------------------------------------
// Progress message registry — tracks all progress messages by thread
// ---------------------------------------------------------------------------

type ProgressStatus = "in_progress" | "completed" | "error";

interface ProgressEntry {
  status: ProgressStatus;
  deps: SlackDeps;
}

/** Map<threadKey, Map<messageTs, ProgressEntry>> */
const progressMessages = new Map<string, Map<string, ProgressEntry>>();

function registerProgress(
  channel: string,
  threadTs: string,
  messageTs: string,
  status: ProgressStatus,
  deps: SlackDeps,
): void {
  const key = threadKey(channel, threadTs);
  let thread = progressMessages.get(key);
  if (!thread) {
    thread = new Map();
    progressMessages.set(key, thread);
  }
  thread.set(messageTs, { status, deps });
}

function updateProgressStatus(
  channel: string,
  threadTs: string,
  messageTs: string,
  status: ProgressStatus,
): void {
  const key = threadKey(channel, threadTs);
  const thread = progressMessages.get(key);
  const entry = thread?.get(messageTs);
  if (entry) {
    entry.status = status;
  }
}

/**
 * Delete all non-error progress messages for a thread.
 * Skips deletion if there is still an active session running.
 */
async function cleanupProgressMessages(
  channel: string,
  threadTs: string,
  trigger: "bot_reply" | "session_end",
): Promise<void> {
  const key = threadKey(channel, threadTs);
  const thread = progressMessages.get(key);
  const hasActiveSession = activeSessions.has(key);
  logInfo(log, "cleanup_progress", {
    trigger,
    key,
    progressCount: thread?.size ?? 0,
    statuses: thread ? [...thread.values()].map((e) => e.status) : [],
    hasActiveSession,
    ts: Date.now(),
  });
  if (!thread) return;

  // If there's still an active session, don't delete progress messages —
  // the session is still running and will update/clean up its own message.
  if (hasActiveSession) {
    logInfo(log, "skip_delete_active_session", { trigger, key });
    return;
  }

  const deletions: Promise<void>[] = [];

  for (const [messageTs, entry] of thread) {
    if (entry.status === "error") continue;

    thread.delete(messageTs);
    deletions.push(
      deleteMessage(channel, messageTs, entry.deps)
        .then(() => logInfo(log, "progress_deleted", { trigger, channel, ts: messageTs, threadTs }))
        .catch((err) =>
          logError(log, "delete_error", err instanceof Error ? err.message : String(err)),
        ),
    );
  }

  await Promise.all(deletions);

  // Clean up thread entry if empty
  if (thread.size === 0) {
    progressMessages.delete(key);
  }
}

/**
 * Called when the bot posts a reply to a thread.
 * Attempts cleanup — will skip if session is still active.
 */
export async function onBotReply(channel: string, threadTs: string): Promise<void> {
  await cleanupProgressMessages(channel, threadTs, "bot_reply");
}

/**
 * Called when a progress session ends (done/error event received).
 * All bot replies have already been sent via the faster MCP path,
 * so this is the reliable cleanup point.
 */
async function onSessionEnd(channel: string, threadTs: string): Promise<void> {
  await cleanupProgressMessages(channel, threadTs, "session_end");
}

/** Visible for testing. */
export function getRegistrySize(): number {
  let count = 0;
  for (const thread of progressMessages.values()) {
    count += thread.size;
  }
  return count;
}

/** Visible for testing. */
export function clearRegistry(): void {
  progressMessages.clear();
  activeSessions.clear();
}

// ---------------------------------------------------------------------------
// Progress session — one per thread
// ---------------------------------------------------------------------------

class ProgressSession {
  private channel: string;
  private threadTs: string;
  private deps: SlackDeps;

  private messageTs?: string;
  private toolCallCount = 0;
  /** Last 3 groups of consecutive identical tool calls. */
  private lastToolGroups: ToolGroup[] = [];
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
    if (this.finished) {
      logInfo(log, "tool_after_finish", {
        channel: this.channel,
        threadTs: this.threadTs,
        tool: toolName,
        ts: Date.now(),
      });
      return;
    }

    this.toolCallCount++;

    const last = this.lastToolGroups[this.lastToolGroups.length - 1];
    if (last && last.name === toolName) {
      last.count++;
    } else {
      this.lastToolGroups.push({ name: toolName, count: 1 });
    }
    // Keep only the last 3 groups
    if (this.lastToolGroups.length > 3) {
      this.lastToolGroups = this.lastToolGroups.slice(-3);
    }

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
    logInfo(log, "session_finish", {
      channel: this.channel,
      threadTs: this.threadTs,
      status,
      alreadyFinished: this.finished,
      toolCallCount: this.toolCallCount,
      hasMessageTs: !!this.messageTs,
      thresholdMet: this.thresholdMet,
      ts: Date.now(),
    });
    if (this.finished) return;
    this.finished = true;

    // Always post errors so failures are never invisible in Slack.
    if (!this.thresholdMet && status === "completed") return;

    const elapsed = formatDuration(Date.now() - this.startTime);

    if (status === "completed") {
      // Only update an existing progress message — never create a new "Done" post.
      // If no progress message was posted (e.g. bot replied before threshold), stay silent.
      if (this.messageTs) {
        const text = `✅ Done — ${this.toolCallCount} tool calls in ${elapsed}`;
        await this.update(text);
        updateProgressStatus(this.channel, this.threadTs, this.messageTs, "completed");
      }
      return;
    }

    const text = `❌ Failed — ${errorMsg || "session error"} after ${this.toolCallCount} tool calls`;
    if (this.messageTs) {
      await this.update(text);
      updateProgressStatus(this.channel, this.threadTs, this.messageTs, "error");
    } else {
      await this.post(text);
      if (this.messageTs) {
        updateProgressStatus(this.channel, this.threadTs, this.messageTs, "error");
      }
    }
  }

  private async flush(): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const toolSuffix =
      this.lastToolGroups.length > 0 ? ` | last: ${formatToolGroups(this.lastToolGroups)}` : "";
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
      const blocks = contextBlocks(text);
      const result = await postMessage(this.channel, text, this.threadTs, this.deps, blocks);
      this.messageTs = result.ts;
      // Register immediately — this is the key to avoiding the race condition
      registerProgress(this.channel, this.threadTs, this.messageTs, "in_progress", this.deps);
      logInfo(log, "progress_posted", { channel: this.channel, ts: this.messageTs });
    } catch (err) {
      logError(log, "post_error", err instanceof Error ? err.message : String(err));
    }
  }

  private async update(text: string): Promise<void> {
    if (!this.messageTs) return;
    try {
      const blocks = contextBlocks(text);
      await updateMessage(this.channel, this.messageTs, text, this.deps, blocks);
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

  logInfo(log, "progress_recv", {
    key,
    type: event.type,
    ...(event.type === "tool" ? { tool: event.tool } : {}),
    ...(event.type === "done" ? { status: event.status } : {}),
    hasSession: activeSessions.has(key),
    ts: Date.now(),
  });

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
      await onSessionEnd(channel, threadTs);
      break;
    case "error":
      await session.finish("error", event.error);
      activeSessions.delete(key);
      await onSessionEnd(channel, threadTs);
      break;
  }
}
