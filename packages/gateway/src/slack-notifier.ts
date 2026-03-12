import type { WebClient } from "@slack/web-api";
import { createLogger, logInfo, logError } from "@thor/common";

const log = createLogger("slack-notifier");

/** Threshold: post first message after this many tool calls. */
const TOOL_CALL_THRESHOLD = 3;
/** Minimum interval between Slack message updates (ms). */
const UPDATE_INTERVAL_MS = 10_000;

export interface SlackNotifierDeps {
  slack: WebClient;
  channel: string;
  threadTs: string;
}

/**
 * Posts and updates a single progress message in a Slack thread
 * while consuming NDJSON progress events from the runner.
 *
 * Lifecycle:
 * 1. Threshold not met → silent
 * 2. Threshold met → post initial message, store ts
 * 3. Periodic updates → edit the same message
 * 4. finish() → final edit with completion status
 */
export class SlackNotifier {
  private deps: SlackNotifierDeps;

  private messageTs?: string;
  private toolCallCount = 0;
  private lastTools: string[] = [];
  private startTime: number;
  private lastUpdateTime = 0;
  private thresholdMet = false;
  private finished = false;

  constructor(deps: SlackNotifierDeps) {
    this.deps = deps;
    this.startTime = Date.now();
  }

  /** Call on each tool_completed or tool_error event. */
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

    // Throttle updates
    if (Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS) {
      await this.flush();
    }
  }

  /** Call when the session finishes. */
  async finish(status: "completed" | "error", errorMsg?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    if (!this.thresholdMet) return; // Short run — no message was ever posted

    const elapsed = formatDuration(Date.now() - this.startTime);
    const text =
      status === "completed"
        ? `✅ Done — ${this.toolCallCount} tool calls in ${elapsed}`
        : `❌ Failed — ${errorMsg || "session error"} after ${this.toolCallCount} tool calls`;

    if (this.messageTs) {
      await this.updateMessage(text);
    } else {
      await this.postMessage(text);
    }
  }

  private async flush(): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const toolSuffix = this.lastTools.length > 0 ? ` | last: ${this.lastTools.join(", ")}` : "";
    const text = `⏳ Working... ${this.toolCallCount} tool calls | ${elapsed} elapsed${toolSuffix}`;

    if (this.messageTs) {
      await this.updateMessage(text);
    } else {
      await this.postMessage(text);
    }

    this.lastUpdateTime = Date.now();
  }

  private async postMessage(text: string): Promise<void> {
    try {
      const result = await this.deps.slack.chat.postMessage({
        channel: this.deps.channel,
        text,
        thread_ts: this.deps.threadTs,
      });
      this.messageTs = result.ts;
      logInfo(log, "progress_posted", { channel: this.deps.channel, ts: this.messageTs });
    } catch (err) {
      logError(log, "post_error", err instanceof Error ? err.message : String(err));
    }
  }

  private async updateMessage(text: string): Promise<void> {
    if (!this.messageTs) return;

    try {
      await this.deps.slack.chat.update({
        channel: this.deps.channel,
        ts: this.messageTs,
        text,
      });
    } catch (err) {
      logError(log, "update_error", err instanceof Error ? err.message : String(err));
    }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}
