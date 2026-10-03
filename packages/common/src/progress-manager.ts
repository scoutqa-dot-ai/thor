import { createLogger, logInfo, logError } from "./logger.js";
import { formatDuration, formatTokens } from "./format.js";
import type { ProgressEvent } from "./progress-events.js";

const log = createLogger("progress");

/** Threshold: post first message after this many tool calls. */
const TOOL_CALL_THRESHOLD = 3;
/** Minimum interval between Slack message updates (ms). */
const UPDATE_INTERVAL_MS = 10_000;

/** Base ticker cadence: refresh elapsed timer in Slack when no events arrive. */
const TICK_INTERVAL_MS = 10_000;

/** Pick ticker delay based on how long the session has been running.
 * Long-running sessions tick less often so we don't waste Slack updates on
 * a counter ticking up by tiny relative increments. */
function tickDelayForElapsed(elapsedMs: number): number {
  if (elapsedMs > 60 * 60_000) return 60_000; // >60m → 1m
  if (elapsedMs > 10 * 60_000) return 30_000; // >10m → 30s
  return TICK_INTERVAL_MS; // 10s
}

/** A run of consecutive identical tool calls. */
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
}

interface DelegateGroup {
  name: string;
  count: number;
}

interface ContextStatus {
  providerID: string;
  modelID: string;
  tokens: number;
  limit: number;
  usagePercent: number;
}

/** Format tool groups for display: [{name:"grep",count:2},{name:"read",count:1}] → "grep x2, read" */
function formatToolGroups(groups: ToolGroup[]): string {
  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name)).join(", ");
}

const MEMORY_ROOT_PREFIX = "/workspace/memory/";

function isReadmePath(path: string): boolean {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  return base.toLowerCase() === "readme.md";
}

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

function shouldRenderContext(context: ContextStatus | undefined): context is ContextStatus {
  // Compare on the same rounded percent we render, so a nominal 50% (e.g. 49.9
  // from float math) isn't hidden by the threshold while the rendered line
  // would have shown "50%".
  return !!context && Math.round(context.usagePercent) >= 50;
}

function formatContextStatus(context: ContextStatus): string {
  return `${Math.round(context.usagePercent)}% (${formatTokens(context.tokens)} / ${formatTokens(context.limit)} tokens)`;
}

function renderedContextText(context: ContextStatus | undefined): string | undefined {
  if (!shouldRenderContext(context)) return undefined;
  return formatContextStatus(context);
}

function isBogusContextStatus(context: ContextStatus): boolean {
  return (
    !Number.isFinite(context.tokens) ||
    !Number.isFinite(context.limit) ||
    !Number.isFinite(context.usagePercent) ||
    context.tokens <= 0 ||
    context.limit <= 0
  );
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

/** Wrap text in a context block for compact, muted rendering in Slack. */
function contextBlocks(text: string, imageUrl?: string): ProgressBlock[] {
  const truncated =
    text.length > BLOCK_TEXT_LIMIT ? text.slice(0, BLOCK_TEXT_LIMIT - 1) + "…" : text;
  return [
    {
      type: "context",
      elements: [
        ...(imageUrl ? [{ type: "image", image_url: imageUrl, alt_text: "Neo activity" }] : []),
        { type: "mrkdwn", text: truncated },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Progress message registry — tracks all progress messages by thread
// ---------------------------------------------------------------------------

export interface ProgressTransport<TTarget = unknown> {
  post(target: TTarget, text: string, blocks?: ProgressBlock[]): Promise<{ ts: string }>;
  update(target: TTarget, messageTs: string, text: string, blocks?: ProgressBlock[]): Promise<void>;
  delete(target: TTarget, messageTs: string): Promise<void>;
  addReaction(target: TTarget, timestamp: string, name: string): Promise<void>;
}

export type ProgressBlock = { type: string; [key: string]: unknown };

export interface ProgressTarget<TTarget = unknown> {
  key: string;
  sourceTs: string;
  /** Safe public asset origin, never a task/viewer URL. Unconfigured targets stay text-only. */
  assetBaseUrl?: string;
  transportTarget: TTarget;
}

type ProgressStatus = "in_progress" | "completed" | "error";

interface ProgressEntry {
  status: ProgressStatus;
  transport: ProgressTransport;
  target: unknown;
}

/** Map<threadKey, Map<messageTs, ProgressEntry>> */
const progressMessages = new Map<string, Map<string, ProgressEntry>>();

/** Cap retained error entries per thread. Without this, every failed session
 * leaves a permanent entry and the per-thread map keeps the threadKey alive
 * across the process lifetime. The most recent N errors are sufficient for
 * users to inspect; older ones are forgotten from the registry but stay
 * visible in Slack. */
const MAX_ERROR_ENTRIES_PER_THREAD = 5;

function registerProgress(
  key: string,
  messageTs: string,
  status: ProgressStatus,
  transport: ProgressTransport,
  target: unknown,
): void {
  let thread = progressMessages.get(key);
  if (!thread) {
    thread = new Map();
    progressMessages.set(key, thread);
  }
  thread.set(messageTs, { status, transport, target });
}

function evictExcessErrors(thread: Map<string, ProgressEntry>): void {
  const errorTimestamps: string[] = [];
  for (const [ts, entry] of thread) {
    if (entry.status === "error") errorTimestamps.push(ts);
  }
  while (errorTimestamps.length > MAX_ERROR_ENTRIES_PER_THREAD) {
    const oldest = errorTimestamps.shift()!;
    thread.delete(oldest);
  }
}

function updateProgressStatus(key: string, messageTs: string, status: ProgressStatus): void {
  const thread = progressMessages.get(key);
  const entry = thread?.get(messageTs);
  if (entry) {
    entry.status = status;
    if (status === "error" && thread) {
      evictExcessErrors(thread);
    }
  }
}

/**
 * Delete all non-error progress messages for a thread.
 * Skips deletion if there is still an active session running.
 */
async function cleanupProgressMessages(key: string): Promise<void> {
  const thread = progressMessages.get(key);
  const hasActiveSession = activeSessions.has(key);
  logInfo(log, "cleanup_progress", {
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
    logInfo(log, "skip_delete_active_session", { key });
    return;
  }

  const deletions: Promise<void>[] = [];

  // Drop entries from the registry only after chat.delete confirms (or after a
  // permanent message_not_found). Transient Slack failures keep the entry so
  // the next session-end cleanup can retry. Without this, a failed delete
  // would leave the message visible in Slack forever with no record to retry
  // from.
  for (const [messageTs, entry] of thread) {
    if (entry.status === "error") continue;

    deletions.push(
      entry.transport
        .delete(entry.target, messageTs)
        .then(() => {
          thread.delete(messageTs);
          logInfo(log, "progress_deleted", { key, ts: messageTs });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("message_not_found")) {
            thread.delete(messageTs);
          }
          logError(log, "delete_error", message);
        }),
    );
  }

  await Promise.all(deletions);

  // Cap any error entries we left behind so the per-thread map cannot grow
  // unbounded across the process lifetime.
  evictExcessErrors(thread);

  if (thread.size === 0) {
    progressMessages.delete(key);
  }
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
  for (const session of activeSessions.values()) void session.abandon();
  progressMessages.clear();
  activeSessions.clear();
  latestScopes.clear();
  seenRequests.clear();
}

// ---------------------------------------------------------------------------
// Progress session — one per thread
// ---------------------------------------------------------------------------

class ProgressSession {
  readonly sessionId: string | undefined;
  readonly requestId: string | undefined;
  private messageTs?: string;
  private sourceTs: string;
  private toolCallCount = 0;
  private completedTools = new Set<string>();
  private lastToolGroups: ToolGroup[] = [];
  private recentMemory: MemoryActivity[] = [];
  private recentDelegates: DelegateActivity[] = [];
  private latestContext?: ContextStatus;
  private activity: "thinking" | "working" | "responding" = "thinking";
  private startTime = Date.now();
  private lastUpdateTime = 0;
  private thresholdMet = false;
  private finished = false;
  private abandoned = false;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private pending?: string;
  private sending?: Promise<void>;
  private inFlight?: Promise<boolean>;

  constructor(
    private progressTarget: ProgressTarget,
    private transport: ProgressTransport,
    sessionId?: string,
    requestId?: string,
  ) {
    this.sourceTs = progressTarget.sourceTs;
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.tickTimer = setTimeout(() => void this.onTick(), 1500);
    this.tickTimer.unref?.();
  }

  private stop(): void {
    this.finished = true;
    this.pending = undefined;
    clearTimeout(this.tickTimer);
  }

  /** Supersession stops ownership synchronously, then drains even a delayed initial post. */
  async abandon(): Promise<void> {
    this.abandoned = true;
    this.stop();
    await this.sending;
    await this.inFlight;
    await this.removeMessage();
  }

  private async onTick(): Promise<void> {
    if (this.finished) return;
    this.thresholdMet = true;
    await this.flush();
    if (!this.finished) {
      this.tickTimer = setTimeout(
        () => void this.onTick(),
        tickDelayForElapsed(Date.now() - this.startTime),
      );
      this.tickTimer.unref?.();
    }
  }

  setSourceTs(sourceTs: string): void {
    // Scoped receipts own their source; later events cannot retarget a reaction.
    if (!this.requestId) this.sourceTs = sourceTs;
  }

  async onActivity(activity: "thinking" | "working" | "responding"): Promise<void> {
    if (this.finished || this.activity === activity) return;
    this.activity = activity;
    if (this.thresholdMet) await this.flush();
  }

  async onToolCall(event: Extract<ProgressEvent, { type: "tool" }>): Promise<void> {
    if (this.finished) return;
    if (event.status === "running") {
      await this.onActivity("working");
      return;
    }
    if (event.toolCallId) {
      if (this.completedTools.has(event.toolCallId)) return;
      this.completedTools.add(event.toolCallId);
    }
    this.toolCallCount++;
    const last = this.lastToolGroups.at(-1);
    if (last?.name === event.tool) last.count++;
    else this.lastToolGroups.push({ name: event.tool, count: 1 });
    this.lastToolGroups = this.lastToolGroups.slice(-5);
    // Legacy callers emit only completions; Pi separately projects its actual next phase.
    if (!this.requestId) this.activity = "working";
    if (!this.thresholdMet && this.toolCallCount >= TOOL_CALL_THRESHOLD) {
      this.thresholdMet = true;
      await this.flush();
    } else if (this.thresholdMet && Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS) {
      await this.flush();
    }
  }

  async onMemory(activity: MemoryActivity): Promise<void> {
    if (this.finished || (activity.action === "read" && isReadmePath(activity.path))) return;
    this.recentMemory = [...this.recentMemory, activity].slice(-4);
    if (this.thresholdMet) await this.flush();
  }

  async onDelegate(activity: DelegateActivity): Promise<void> {
    if (this.finished) return;
    this.recentDelegates = [...this.recentDelegates, activity].slice(-4);
    if (this.thresholdMet) await this.flush();
  }

  async onContext(status: ContextStatus): Promise<void> {
    if (this.finished) return;
    const previous = renderedContextText(this.latestContext);
    if (previous !== undefined && isBogusContextStatus(status)) return;
    this.latestContext = status;
    const next = renderedContextText(status);
    if (
      this.thresholdMet &&
      previous !== next &&
      (previous === undefined ||
        next === undefined ||
        Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS)
    )
      await this.flush();
  }

  async finish(status: "completed" | "error" | "waiting", errorMsg?: string): Promise<void> {
    logInfo(log, "session_finish", {
      key: this.progressTarget.key,
      sessionId: this.sessionId,
      requestId: this.requestId,
      status,
      alreadyFinished: this.finished,
      toolCallCount: this.toolCallCount,
      hasMessageTs: !!this.messageTs,
      thresholdMet: this.thresholdMet,
    });
    if (this.finished) return;
    this.stop();
    await this.sending;
    if (this.abandoned) return;
    if (status === "waiting") {
      // Waiting is visible even for a short request, with no moving mark.
      const delivered = await this.sendText(
        "⏳ Neo waiting for Google sign-in — the task will automatically continue.",
        "terminal",
      );
      if (!delivered) await this.removeMessage();
      return;
    }
    if (status === "completed") {
      const completedText = `✅ Done — ${this.toolCallCount} tool calls in ${formatDuration(Date.now() - this.startTime)}`;
      if (this.messageTs) await this.sendText(completedText, "terminal");
      if (!this.abandoned && this.sourceTs) {
        try {
          await this.transport.addReaction(
            this.progressTarget.transportTarget,
            this.sourceTs,
            "white_check_mark",
          );
        } catch {
          logError(log, "reaction_error", "Progress completion reaction unavailable");
        }
      }
      await this.removeMessage(completedText);
    } else if (errorMsg && /abort|interrupt|supersed/i.test(errorMsg)) {
      await this.removeMessage();
    } else if (this.messageTs) {
      const delivered = await this.sendText(
        `❌ Neo failed — ${errorMsg || "session error"} after ${this.toolCallCount} tool calls`,
        "terminal",
      );
      if (delivered && this.messageTs)
        updateProgressStatus(this.progressTarget.key, this.messageTs, "error");
      else await this.removeMessage();
    } else if (this.sourceTs) {
      try {
        await this.transport.addReaction(this.progressTarget.transportTarget, this.sourceTs, "x");
      } catch {
        logError(log, "reaction_error", "Progress failure reaction unavailable");
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.finished) return;
    const context = shouldRenderContext(this.latestContext) ? this.latestContext : undefined;
    const hasExtras = this.recentMemory.length > 0 || this.recentDelegates.length > 0 || !!context;
    const tools = this.lastToolGroups.slice(-(hasExtras ? 5 : 3));
    const label = {
      thinking: "Neo thinking",
      working: "Neo working",
      responding: "Neo responding",
    }[this.activity];
    const header = `⏳ ${label}... ${this.toolCallCount} tool calls | ${formatDuration(Date.now() - this.startTime)} elapsed`;
    const lines = [
      tools.length && !hasExtras ? `${header} | latest: ${formatToolGroups(tools)}` : header,
    ];
    if (tools.length && hasExtras) lines.push(`• tools: ${formatToolGroups(tools)}`);
    if (this.recentMemory.length)
      lines.push(`• memory: ${formatMemoryActivities(this.recentMemory)}`);
    if (this.recentDelegates.length)
      lines.push(`• agents: ${formatDelegates(this.recentDelegates)}`);
    if (context) lines.push(`• context: ${formatContextStatus(context)}`);
    this.lastUpdateTime = Date.now();
    // Latest desired payload wins while one network operation is in flight.
    this.pending = lines.join("\n");
    if (!this.sending) {
      this.sending = (async () => {
        while (this.pending && !this.finished) {
          const text = this.pending;
          this.pending = undefined;
          await this.sendText(text, "active");
        }
      })();
      this.sending = this.sending.finally(() => {
        this.sending = undefined;
        if (this.pending && !this.finished) void this.flush();
      });
    }
    await this.sending;
  }

  private async sendText(text: string, phase: "active" | "terminal"): Promise<boolean> {
    if (this.abandoned) return false;
    const path =
      phase === "terminal" || this.activity === "responding"
        ? "/neo-ai-still-v1.png"
        : this.activity === "working"
          ? "/neo-working-v1.gif"
          : "/neo-thinking-v1.gif";
    const blocks = contextBlocks(
      text,
      publicProgressAssetUrl(this.progressTarget.assetBaseUrl, path),
    );
    this.inFlight = (async () => {
      try {
        if (this.messageTs)
          await this.transport.update(
            this.progressTarget.transportTarget,
            this.messageTs,
            text,
            blocks,
          );
        else {
          const result = await this.transport.post(
            this.progressTarget.transportTarget,
            text,
            blocks,
          );
          if (!result.ts) return false;
          this.messageTs = result.ts;
          registerProgress(
            this.progressTarget.key,
            result.ts,
            "in_progress",
            this.transport,
            this.progressTarget.transportTarget,
          );
          logInfo(log, "progress_posted", { key: this.progressTarget.key, ts: result.ts });
        }
        return true;
      } catch {
        logError(log, "send_error", "Progress delivery unavailable");
        return false;
      }
    })();
    const delivered = await this.inFlight;
    this.inFlight = undefined;
    return delivered;
  }

  private async removeMessage(stoppedText = "Neo stopped"): Promise<void> {
    if (!this.messageTs) return;
    const ts = this.messageTs;
    // Stop motion before deletion: a transient delete failure must not leave an active GIF.
    try {
      await this.transport.update(
        this.progressTarget.transportTarget,
        ts,
        stoppedText,
        contextBlocks(
          stoppedText,
          publicProgressAssetUrl(this.progressTarget.assetBaseUrl, "/neo-ai-still-v1.png"),
        ),
      );
    } catch {
      logError(log, "update_error", "Progress stop update unavailable");
    }
    updateProgressStatus(this.progressTarget.key, ts, "completed");
    try {
      await this.transport.delete(this.progressTarget.transportTarget, ts);
      const key = this.progressTarget.key;
      const thread = progressMessages.get(key);
      thread?.delete(ts);
      if (thread?.size === 0) progressMessages.delete(key);
      this.messageTs = undefined;
    } catch {
      logError(log, "delete_error", "Progress cleanup unavailable");
    }
  }
}

/** Build only fixed public artwork URLs; invalid/credential-bearing bases stay text-only. */
function publicProgressAssetUrl(base: string | undefined, path: string): string | undefined {
  if (!base?.trim()) return undefined;
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return new URL(path, url).href;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Active sessions registry
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, ProgressSession>();
// Bounded replay evidence also rejects late events after a terminal footer was removed.
const latestScopes = new Map<string, { sessionId?: string; requestId?: string }>();
const seenRequests = new Set<string>();

/**
 * Handle a progress event for a specific thread.
 * Creates/reuses a ProgressSession per channel+threadTs.
 */
export async function handleProgressEvent(
  target: ProgressTarget,
  event: ProgressEvent,
  transport: ProgressTransport,
): Promise<void> {
  const key = target.key;

  logInfo(log, "progress_recv", {
    key,
    type: event.type,
    ...(event.type === "tool" ? { tool: event.tool } : {}),
    ...(event.type === "memory"
      ? { action: event.action, path: event.path, source: event.source }
      : {}),
    ...(event.type === "delegate" ? { agent: event.agent } : {}),
    ...(event.type === "context"
      ? {
          providerID: event.providerID,
          modelID: event.modelID,
          tokens: event.tokens,
          limit: event.limit,
          usagePercent: event.usagePercent,
        }
      : {}),
    ...(event.type === "done" ? { status: event.status } : {}),
    hasSession: activeSessions.has(key),
    ts: Date.now(),
  });

  // A transport heartbeat is not evidence of an active task.
  if (event.type === "heartbeat") return;

  if (event.type === "start") {
    // Abandon any prior session on this thread so its tickTimer stops and it
    // can no longer post or edit messages — otherwise the orphan keeps
    // editing the OLD progress message while the new session runs.
    const prior = activeSessions.get(key);
    if (event.requestId) {
      const identity = `${key}:${event.requestId}`;
      if (seenRequests.has(identity)) return;
      seenRequests.add(identity);
      const oldest = seenRequests.values().next().value;
      if (seenRequests.size > 2000 && oldest !== undefined) seenRequests.delete(oldest);
    }
    latestScopes.set(key, { sessionId: event.sessionId, requestId: event.requestId });
    const oldestKey = latestScopes.keys().next().value;
    if (latestScopes.size > 1000 && oldestKey !== undefined) latestScopes.delete(oldestKey);
    activeSessions.set(
      key,
      new ProgressSession(target, transport, event.sessionId, event.requestId),
    );
    if (prior) await prior.abandon();
    return;
  }

  let session = activeSessions.get(key);
  const scope = session ?? latestScopes.get(key);
  if (
    (scope?.requestId && event.requestId !== scope.requestId) ||
    (scope?.sessionId && event.sessionId && event.sessionId !== scope.sessionId)
  )
    return;

  if (!session) {
    if (event.requestId || scope) return; // Known retired streams require a new start.
    // Late-arriving event without start — create session on the fly
    session = new ProgressSession(target, transport);
    activeSessions.set(key, session);
  }
  session.setSourceTs(target.sourceTs);

  switch (event.type) {
    case "activity":
      await session.onActivity(event.activity);
      break;
    case "tool":
      await session.onToolCall(event);
      break;
    case "memory":
      await session.onMemory({ action: event.action, path: event.path, source: event.source });
      break;
    case "delegate":
      await session.onDelegate({ agent: event.agent });
      break;
    case "context":
      await session.onContext({
        providerID: event.providerID,
        modelID: event.modelID,
        tokens: event.tokens,
        limit: event.limit,
        usagePercent: event.usagePercent,
      });
      break;
    case "done": {
      // A late `done` from a superseded stream must not finish the current
      // session. Match the event's sessionId to the active session — if they
      // differ, this `done` belongs to an older stream and is ignored.
      if (session.sessionId && event.sessionId && session.sessionId !== event.sessionId) {
        logInfo(log, "done_session_mismatch", {
          key,
          eventSessionId: event.sessionId,
          activeSessionId: session.sessionId,
        });
        return;
      }
      await session.finish(
        event.authWait === "google"
          ? "waiting"
          : event.status === "completed"
            ? "completed"
            : "error",
        event.error,
      );
      if (activeSessions.get(key) === session && !event.authWait) {
        activeSessions.delete(key);
        await cleanupProgressMessages(target.key);
      }
      break;
    }
    case "error":
      await session.finish("error", event.error);
      if (activeSessions.get(key) === session) {
        activeSessions.delete(key);
        await cleanupProgressMessages(target.key);
      }
      break;
  }
}
