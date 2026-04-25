import { createLogger, logInfo, logError } from "@thor/common";
import type { ProgressEvent } from "@thor/common";
import {
  postMessage,
  updateMessage,
  deleteMessage,
  addReaction,
  type SlackDeps,
  type SlackBlock,
} from "./slack-api.js";

const log = createLogger("gateway-progress");

const TOOL_CALL_THRESHOLD = 3;
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

interface ToolGroup {
  name: string;
  count: number;
}

interface MemoryActivity {
  action: "read" | "write";
  path: string;
  source: "bootstrap" | "tool";
}

interface DelegateActivity {
  agent: string;
  description?: string;
}

interface DelegateGroup {
  name: string;
  count: number;
}

/** Format tool groups for display: [{name:"grep",count:2},{name:"read",count:1}] → "grep x2, read" */
function formatToolGroups(groups: ToolGroup[]): string {
  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name)).join(", ");
}

const MEMORY_ROOT_PREFIX = "/workspace/memory/";

function shortenMemoryPath(path: string): string {
  if (path.startsWith(MEMORY_ROOT_PREFIX)) {
    return path.slice(MEMORY_ROOT_PREFIX.length);
  }
  if (path === "/workspace/memory") {
    return ".";
  }
  return path;
}

function formatMemoryActivities(activities: MemoryActivity[]): string {
  const shortPaths = activities.map((activity) => shortenMemoryPath(activity.path));
  const distinctPaths = [...new Set(shortPaths)];

  if (distinctPaths.length < 3) {
    return formatMemoryFileLabels(distinctPaths);
  }

  const readCount = activities.filter((activity) => activity.action === "read").length;
  const writeCount = activities.filter((activity) => activity.action === "write").length;

  const summaries: string[] = [];
  if (readCount > 0) summaries.push(`read x${readCount}`);
  if (writeCount > 0) summaries.push(`write x${writeCount}`);
  return summaries.join(", ");
}

function formatDelegates(activities: DelegateActivity[]): string {
  const groups: DelegateGroup[] = [];
  for (const activity of activities) {
    const last = groups[groups.length - 1];
    if (last && last.name === activity.agent) {
      last.count++;
      continue;
    }
    groups.push({ name: activity.agent, count: 1 });
  }

  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name)).join(", ");
}

function formatMemoryFileLabels(shortPaths: string[]): string {
  if (shortPaths.length === 0) return "";

  const splitPath = (path: string): string[] => {
    if (path === ".") return ["."];
    return path.split("/").filter(Boolean);
  };

  const partsByPath = new Map(shortPaths.map((path) => [path, splitPath(path)]));
  const groupedByBase = new Map<string, string[]>();

  for (const path of shortPaths) {
    const parts = partsByPath.get(path) ?? [path];
    const base = parts[parts.length - 1] ?? path;
    const group = groupedByBase.get(base) ?? [];
    group.push(path);
    groupedByBase.set(base, group);
  }

  const labels = new Map<string, string>();

  for (const [base, paths] of groupedByBase) {
    if (paths.length === 1) {
      labels.set(paths[0], base);
      continue;
    }

    const maxDepth = Math.max(...paths.map((path) => (partsByPath.get(path) ?? [path]).length));
    let assigned = false;

    for (let depth = 2; depth <= maxDepth; depth++) {
      const candidates = paths.map((path) => {
        const parts = partsByPath.get(path) ?? [path];
        const start = Math.max(parts.length - depth, 0);
        return parts.slice(start).join("/");
      });

      if (new Set(candidates).size !== paths.length) continue;

      paths.forEach((path, idx) => labels.set(path, candidates[idx]));
      assigned = true;
      break;
    }

    if (!assigned) {
      paths.forEach((path) => labels.set(path, path));
    }
  }

  return shortPaths.map((path) => labels.get(path) ?? path).join(", ");
}

/** Max characters for a Block Kit mrkdwn text object. */
const BLOCK_TEXT_LIMIT = 3000;

function contextBlocks(text: string): SlackBlock[] {
  const truncated =
    text.length > BLOCK_TEXT_LIMIT ? text.slice(0, BLOCK_TEXT_LIMIT - 1) + "…" : text;
  return [{ type: "context", elements: [{ type: "mrkdwn", text: truncated }] }];
}

type ProgressStatus = "in_progress" | "completed" | "error";

interface ProgressEntry {
  status: ProgressStatus;
  deps: SlackDeps;
}

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

  if (thread.size === 0) {
    progressMessages.delete(key);
  }
}

export async function onBotReply(channel: string, threadTs: string): Promise<void> {
  await cleanupProgressMessages(channel, threadTs, "bot_reply");
}

async function onSessionEnd(channel: string, threadTs: string): Promise<void> {
  await cleanupProgressMessages(channel, threadTs, "session_end");
}

export function getRegistrySize(): number {
  let count = 0;
  for (const thread of progressMessages.values()) {
    count += thread.size;
  }
  return count;
}

export function clearRegistry(): void {
  progressMessages.clear();
  activeSessions.clear();
}

class ProgressSession {
  private channel: string;
  private threadTs: string;
  private deps: SlackDeps;
  private sourceTs: string;

  private messageTs?: string;
  private toolCallCount = 0;
  private lastToolGroups: ToolGroup[] = [];
  /** Recent memory activity from bootstrap/tool file access. */
  private recentMemory: MemoryActivity[] = [];
  /** Recent delegated agents from subtask parts. */
  private recentDelegates: DelegateActivity[] = [];
  private startTime: number;
  private lastUpdateTime = 0;
  private thresholdMet = false;
  private finished = false;

  constructor(channel: string, threadTs: string, deps: SlackDeps, sourceTs: string) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.deps = deps;
    this.sourceTs = sourceTs;
    this.startTime = Date.now();
  }

  setSourceTs(sourceTs: string): void {
    this.sourceTs = sourceTs;
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

  async onMemory(activity: MemoryActivity): Promise<void> {
    if (this.finished) return;

    this.recentMemory.push(activity);
    if (this.recentMemory.length > 4) {
      this.recentMemory = this.recentMemory.slice(-4);
    }

    if (this.thresholdMet) {
      await this.flush();
    }
  }

  async onDelegate(activity: DelegateActivity): Promise<void> {
    if (this.finished) return;

    this.recentDelegates.push(activity);
    if (this.recentDelegates.length > 4) {
      this.recentDelegates = this.recentDelegates.slice(-4);
    }

    if (this.thresholdMet) {
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

    if (status === "error" && errorMsg && /abort/i.test(errorMsg)) {
      logInfo(log, "session_abort_as_completed", {
        channel: this.channel,
        threadTs: this.threadTs,
        errorMsg,
        toolCallCount: this.toolCallCount,
      });
      status = "completed";
      errorMsg = undefined;
    }

    if (!this.thresholdMet && status === "completed") return;

    const elapsed = formatDuration(Date.now() - this.startTime);

    if (status === "completed") {
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
      await addReaction(this.channel, this.sourceTs, "x", this.deps).catch((err) =>
        logError(log, "reaction_error", err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async flush(): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const lines = [`⏳ Working... ${this.toolCallCount} tool calls | ${elapsed} elapsed`];

    if (this.lastToolGroups.length > 0) {
      lines.push(`• tools: ${formatToolGroups(this.lastToolGroups)}`);
    }
    if (this.recentMemory.length > 0) {
      lines.push(`• memory: ${formatMemoryActivities(this.recentMemory)}`);
    }
    if (this.recentDelegates.length > 0) {
      lines.push(`• agents: ${formatDelegates(this.recentDelegates)}`);
    }

    const text = lines.join("\n");

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

const activeSessions = new Map<string, ProgressSession>();

export async function handleProgressEvent(
  channel: string,
  threadTs: string,
  event: ProgressEvent,
  deps: SlackDeps,
  sourceTs: string,
): Promise<void> {
  const key = threadKey(channel, threadTs);

  logInfo(log, "progress_recv", {
    key,
    type: event.type,
    ...(event.type === "tool" ? { tool: event.tool } : {}),
    ...(event.type === "memory"
      ? { action: event.action, path: event.path, source: event.source }
      : {}),
    ...(event.type === "delegate" ? { agent: event.agent, description: event.description } : {}),
    ...(event.type === "done" ? { status: event.status } : {}),
    hasSession: activeSessions.has(key),
    ts: Date.now(),
  });

  if (event.type === "start") {
    activeSessions.set(key, new ProgressSession(channel, threadTs, deps, sourceTs));
    return;
  }

  let session = activeSessions.get(key);
  if (!session) {
    session = new ProgressSession(channel, threadTs, deps, sourceTs);
    activeSessions.set(key, session);
  }
  session.setSourceTs(sourceTs);

  switch (event.type) {
    case "tool":
      await session.onToolCall(event.tool);
      break;
    case "memory":
      await session.onMemory({ action: event.action, path: event.path, source: event.source });
      break;
    case "delegate":
      await session.onDelegate({
        agent: event.agent,
        ...(event.description ? { description: event.description } : {}),
      });
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
