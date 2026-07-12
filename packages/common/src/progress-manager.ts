import { createLogger, logInfo, logError } from "./logger.ts";
import { formatDuration, formatTokens } from "./format.ts";
import type { ProgressEvent } from "./progress-events.ts";

const log = createLogger("progress");

/** Threshold: post first message after this many tool calls. */
const TOOL_CALL_THRESHOLD = 3;
/** Minimum interval between Slack message updates (ms). */
const UPDATE_INTERVAL_MS = 10_000;

/** Base ticker cadence: refresh elapsed timer in Slack when no events arrive. */
const TICK_INTERVAL_MS = 10_000;

/**
 * Backstop max age for a live session. Slack progress is now finalized only by
 * the listener's parent `session.idle`; if that idle never arrives (dropped
 * SSE, runner restart mid-run, OpenCode crash, abort without idle) the session
 * would tick and stay resident forever. Evict it after this window so orphans
 * cannot accumulate over process uptime. Generous on purpose — a backstop, not
 * a normal completion path. The orphan Slack bubble is left as-is.
 */
const SESSION_MAX_AGE_MS = 6 * 60 * 60_000; // 6h

/** Pick ticker delay based on how long the session has been running.
 * Long-running sessions tick less often so we don't waste Slack updates on
 * a counter ticking up by tiny relative increments. */
function tickDelayForElapsed(elapsedMs: number): number {
  if (elapsedMs > 60 * 60_000) return 60_000; // >60m → 1m
  if (elapsedMs > 10 * 60_000) return 30_000; // >10m → 30s
  return TICK_INTERVAL_MS; // 10s
}

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
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

// ---------------------------------------------------------------------------
// Audit signals — activity worth persisting past session end
// ---------------------------------------------------------------------------
//
// Most progress activity is transient: tool calls, memory reads, and context
// usage are cleaned up when the session completes so the thread stays quiet. A
// few signals represent consequential, durable facts about a run that a user
// may want to review afterwards. When a completed session recorded any of
// these, its progress message is finalized into an audit summary and retained
// instead of deleted.
//
// Two signals are persisted today:
//   • memory writes — durable side effects on the memory store
//   • errors        — every session error seen mid-run, whether the run later
//                     recovered (completed) or failed (fatal)
// Deliberately NOT persisted: tool calls, memory reads, delegations, and
// context usage — all transient runtime state with no lasting consequence.
//
// This set is intended to grow. To persist a new signal: add a field here,
// accumulate it in the matching ProgressSession.on* handler, and add a
// render*Section for it in renderAuditSummary below.
interface AuditSignals {
  /** Distinct memory paths written, in first-write order. */
  memoryWrites: string[];
  /** Occurrence count per classified error label seen mid-run (see
   * classifyError), in first-seen order. */
  errors: Map<string, number>;
}

/**
 * Aborts are intentional interruptions (e.g. a new message superseded the run)
 * that get re-triggered — treated as completed and never audited as errors.
 * Single source of truth for both the finish() reclassification and the
 * session-error accumulator.
 */
function isAbortError(message: string): boolean {
  return /abort/i.test(message);
}

/** Keep a single audit error line compact. */
const AUDIT_ERROR_MAX_LEN = 160;

function truncateErrorMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > AUDIT_ERROR_MAX_LEN
    ? collapsed.slice(0, AUDIT_ERROR_MAX_LEN - 1) + "…"
    : collapsed;
}

/**
 * Map a raw session-error message to a stable audit label. Known noisy shapes
 * (high-cardinality provider payloads) collapse to a canonical label so one
 * incident renders as one counted bullet. Anything unrecognized keeps its raw
 * message (compacted for length) so novel failures stay visible instead of
 * hiding behind a generic bucket.
 *
 * Patterns are seeded from observed production errors and matched in order
 * (first match wins). `Aborted` is filtered upstream (see isAbortError), so it
 * needs no entry here.
 */
const KNOWN_ERROR_PATTERNS: Array<{ match: RegExp; label: string }> = [
  { match: /server_is_overloaded/i, label: "Provider overloaded" },
  { match: /exceeds context window/i, label: "Context window exceeded" },
  { match: /image_url/i, label: "Invalid image input" },
];

function classifyError(message: string): string {
  for (const { match, label } of KNOWN_ERROR_PATTERNS) {
    if (match.test(message)) return label;
  }
  return truncateErrorMessage(message);
}

function renderMemoryWriteSection(writePaths: string[]): string | undefined {
  if (writePaths.length === 0) return undefined;
  const shortPaths = [...new Set(writePaths.map(shortenMemoryPath))];
  // The files are listed below, so the header only labels the section.
  return ["📝 Memory updated", ...shortPaths.map((path) => `• ${path}`)].join("\n");
}

function renderErrorSection(
  errorCounts: Map<string, number>,
  opts: { failed: boolean; toolCalls: number },
): string | undefined {
  if (errorCounts.size === 0) return undefined;
  const total = [...errorCounts.values()].reduce((sum, count) => sum + count, 0);
  // On a failed run the errors are the headline; on a completed run they were
  // recovered from and are a footnote to whatever the run accomplished.
  const header = opts.failed
    ? `❌ Failed after ${opts.toolCalls} tool calls`
    : `⚠️ Recovered from ${total} ${total === 1 ? "error" : "errors"} during the run`;
  // Keys are already classified, display-ready labels (see classifyError).
  const lines = [...errorCounts].map(
    ([label, count]) => `• ${count > 1 ? `${label} x${count}` : label}`,
  );
  return [header, ...lines].join("\n");
}

/**
 * Render the durable audit summary for a finished session, or undefined when no
 * audit-worthy signal was recorded (so the message is cleaned up as usual). A
 * failed run always has at least one error signal, so it always renders.
 */
function renderAuditSummary(
  signals: AuditSignals,
  opts: { failed: boolean; toolCalls: number },
): string | undefined {
  const memory = renderMemoryWriteSection(signals.memoryWrites);
  const errors = renderErrorSection(signals.errors, opts);
  // Lead with the failure on a failed run; otherwise lead with what was done.
  const sections = (opts.failed ? [errors, memory] : [memory, errors]).filter(
    (section): section is string => section !== undefined,
  );
  return sections.length > 0 ? sections.join("\n") : undefined;
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
function contextBlocks(text: string): ProgressBlock[] {
  const truncated =
    text.length > BLOCK_TEXT_LIMIT ? text.slice(0, BLOCK_TEXT_LIMIT - 1) + "…" : text;
  return [{ type: "context", elements: [{ type: "mrkdwn", text: truncated }] }];
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
  transportTarget: TTarget;
}

interface ProgressEntry {
  transport: ProgressTransport;
  target: unknown;
}

/**
 * Map<threadKey, Map<messageTs, ProgressEntry>> of live progress messages
 * pending cleanup. Only ever holds transient "working…" messages: any message
 * finalized into a retained audit (see retainProgressMessage) is dropped from
 * here at session end, so the registry cannot grow across the process lifetime.
 */
const progressMessages = new Map<string, Map<string, ProgressEntry>>();

function registerProgress(
  channel: string,
  threadTs: string,
  messageTs: string,
  transport: ProgressTransport,
  target: unknown,
): void {
  const key = threadKey(channel, threadTs);
  let thread = progressMessages.get(key);
  if (!thread) {
    thread = new Map();
    progressMessages.set(key, thread);
  }
  thread.set(messageTs, { transport, target });
}

/**
 * Drop a message from the cleanup registry without deleting it from Slack.
 * Used for retained audit messages: cleanup never sees them (so they persist
 * in the thread) and the registry does not grow across the process lifetime.
 */
function retainProgressMessage(channel: string, threadTs: string, messageTs: string): void {
  const key = threadKey(channel, threadTs);
  const thread = progressMessages.get(key);
  if (!thread) return;
  thread.delete(messageTs);
  if (thread.size === 0) {
    progressMessages.delete(key);
  }
}

/**
 * Delete the remaining live progress messages for a thread. Retained audit
 * messages have already been dropped from the registry, so everything left
 * here is a transient "working…" message that should disappear on completion.
 * Skips deletion if there is still an active session running.
 */
async function cleanupProgressMessages(channel: string, threadTs: string): Promise<void> {
  const key = threadKey(channel, threadTs);
  const thread = progressMessages.get(key);
  const hasActiveSession = activeSessions.has(key);
  logInfo(log, "cleanup_progress", {
    key,
    progressCount: thread?.size ?? 0,
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
    deletions.push(
      entry.transport
        .delete(entry.target, messageTs)
        .then(() => {
          thread.delete(messageTs);
          logInfo(log, "progress_deleted", { channel, ts: messageTs, threadTs });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("message_not_found")) {
            thread.delete(messageTs);
            logInfo(log, "progress_delete_message_not_found", { channel, ts: messageTs, threadTs });
            return;
          }
          logError(log, "delete_error", message);
        }),
    );
  }

  await Promise.all(deletions);

  if (thread.size === 0) {
    progressMessages.delete(key);
  }
}

async function onSessionEnd(channel: string, threadTs: string): Promise<void> {
  await cleanupProgressMessages(channel, threadTs);
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
  private sourceTs: string;

  private messageTs?: string;
  private toolCallCount = 0;
  /** Last 5 groups of consecutive identical tool calls. */
  private lastToolGroups: ToolGroup[] = [];
  /** Recent memory activity from bootstrap/tool file access. */
  private recentMemory: MemoryActivity[] = [];
  /** Complete, uncapped record of audit-worthy signals for this session (unlike
   * the display accumulators, which cap and collapse for the live message).
   * Drives the retained audit summary posted on completion. */
  private readonly auditSignals: AuditSignals = {
    memoryWrites: [],
    errors: new Map(),
  };
  /** Last 5 groups of consecutive identical delegated agents. */
  private lastDelegateGroups: DelegateGroup[] = [];
  /** Latest context-window usage update from the runner. */
  private latestContext?: ContextStatus;
  private startTime: number;
  private lastUpdateTime = 0;
  private thresholdMet = false;
  private finished = false;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private progressTarget: ProgressTarget;
  private transport: ProgressTransport;

  constructor(progressTarget: ProgressTarget, transport: ProgressTransport) {
    this.progressTarget = progressTarget;
    this.transport = transport;
    this.channel = progressTarget.key;
    this.threadTs = progressTarget.key;
    this.sourceTs = progressTarget.sourceTs;
    this.startTime = Date.now();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.finished) return;
    const delay = tickDelayForElapsed(Date.now() - this.startTime);
    this.tickTimer = setTimeout(() => {
      void this.onTick();
    }, delay);
  }

  private async onTick(): Promise<void> {
    this.tickTimer = undefined;
    if (this.finished) return;
    // Orphan backstop: a session that never receives a terminal idle would
    // otherwise reschedule forever and stay in activeSessions. Self-evict.
    if (Date.now() - this.startTime >= SESSION_MAX_AGE_MS) {
      this.finished = true;
      activeSessions.delete(this.channel);
      logInfo(log, "session_orphan_evicted", {
        channel: this.channel,
        threadTs: this.threadTs,
        toolCallCount: this.toolCallCount,
      });
      // The normal done path never ran, so run its cleanup here: delete any
      // progress message this orphan posted and drop its registry entry.
      // Without this, both leak for a thread that may never run again.
      await onSessionEnd(this.channel, this.threadTs);
      return;
    }
    try {
      if (this.thresholdMet && this.messageTs) {
        if (Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS) {
          await this.flush();
        }
      }
    } finally {
      this.scheduleNextTick();
    }
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
    // Keep up to 5 groups; flush() decides how many to render
    if (this.lastToolGroups.length > 5) {
      this.lastToolGroups = this.lastToolGroups.slice(-5);
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
    if (activity.action === "read" && isReadmePath(activity.path)) return;

    if (activity.action === "write" && !this.auditSignals.memoryWrites.includes(activity.path)) {
      this.auditSignals.memoryWrites.push(activity.path);
    }

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

    const last = this.lastDelegateGroups[this.lastDelegateGroups.length - 1];
    if (last && last.name === activity.agent) {
      last.count++;
    } else {
      this.lastDelegateGroups.push({ name: activity.agent, count: 1 });
    }
    if (this.lastDelegateGroups.length > 5) {
      this.lastDelegateGroups = this.lastDelegateGroups.slice(-5);
    }

    if (this.thresholdMet) {
      await this.flush();
    }
  }

  /**
   * Record a mid-run session error for the audit summary. Purely accumulative —
   * live failure visibility is handled by the inline "error" tool activity the
   * listener already emits, so this does not flush.
   */
  onSessionError(message: string): void {
    if (this.finished) return;
    // Aborts flow through session.error too; never audit an interrupt as an
    // error — the run is treated as completed and re-triggered.
    if (isAbortError(message)) return;
    this.recordError(message);
  }

  private recordError(message: string): void {
    const label = classifyError(message);
    this.auditSignals.errors.set(label, (this.auditSignals.errors.get(label) ?? 0) + 1);
  }

  async onContext(status: ContextStatus): Promise<void> {
    if (this.finished) return;
    const prevRendered = renderedContextText(this.latestContext);
    if (prevRendered !== undefined && isBogusContextStatus(status)) {
      return;
    }
    this.latestContext = status;
    const nextRendered = renderedContextText(this.latestContext);

    if (!this.thresholdMet) {
      return;
    }

    if (prevRendered === nextRendered) {
      return;
    }

    if (
      prevRendered === undefined ||
      nextRendered === undefined ||
      Date.now() - this.lastUpdateTime >= UPDATE_INTERVAL_MS
    ) {
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
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }

    // Treat aborts as successful completions — the session was intentionally
    // interrupted (e.g. new message arrived) and will be re-triggered.
    if (status === "error" && errorMsg && isAbortError(errorMsg)) {
      logInfo(log, "session_abort_as_completed", {
        channel: this.channel,
        threadTs: this.threadTs,
        errorMsg,
        toolCallCount: this.toolCallCount,
      });
      status = "completed";
      errorMsg = undefined;
    }

    const failed = status === "error";

    // A failed run must always list at least the terminal error so failures are
    // never invisible — defend against a done error that never arrived as a
    // session_error event. (Add only when empty, so recovered errors aren't
    // double-counted.)
    if (failed && this.auditSignals.errors.size === 0) {
      this.recordError(errorMsg || "session error");
    }

    const audit = renderAuditSummary(this.auditSignals, {
      failed,
      toolCalls: this.toolCallCount,
    });

    // No audit-worthy signal on a completed run: no transient "Done" edit — the
    // cleanup path deletes the (possibly never-posted) progress message.
    if (!audit) return;

    if (this.messageTs) {
      await this.finalizeAudit(audit);
      return;
    }

    // Failed before any progress message was posted: keep it lightweight with a
    // reaction on the source message instead of a fresh audit bubble.
    if (failed) {
      await this.transport
        .addReaction(this.progressTarget.transportTarget, this.sourceTs, "x")
        .catch((err: unknown) =>
          logError(log, "reaction_error", err instanceof Error ? err.message : String(err)),
        );
      return;
    }

    // Completed with signals below the tool-call threshold: post the audit fresh.
    await this.finalizeAudit(audit);
  }

  /**
   * Replace the live progress message with the permanent audit summary, then
   * drop it from the cleanup registry so it survives session end. Posts a fresh
   * message if the threshold was never met.
   */
  private async finalizeAudit(text: string): Promise<void> {
    if (this.messageTs) {
      // Retain (drop from the cleanup registry) only if the edit actually
      // landed. If it failed, leave the entry so session-end cleanup deletes
      // the now-stale "Working…" bubble instead of orphaning it with no way to
      // retry or remove it.
      if (await this.update(text)) {
        retainProgressMessage(this.channel, this.threadTs, this.messageTs);
      }
    } else {
      await this.post(text);
      if (this.messageTs) {
        retainProgressMessage(this.channel, this.threadTs, this.messageTs);
      }
    }
  }

  private async flush(): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const context = shouldRenderContext(this.latestContext) ? this.latestContext : undefined;
    const hasExtras =
      this.recentMemory.length > 0 || this.lastDelegateGroups.length > 0 || !!context;
    const recentActivityLimit = hasExtras ? 5 : 3;
    const toolGroups = this.lastToolGroups.slice(-recentActivityLimit);
    const delegateGroups = this.lastDelegateGroups.slice(-recentActivityLimit);

    const header = `⏳ Working... ${this.toolCallCount} tool calls | ${elapsed} elapsed`;
    const lines: string[] = [];

    if (toolGroups.length > 0 && hasExtras) {
      lines.push(header);
      lines.push(`• tools: ${formatToolGroups(toolGroups)}`);
    } else if (toolGroups.length > 0) {
      lines.push(`${header} | latest: ${formatToolGroups(toolGroups)}`);
    } else {
      lines.push(header);
    }

    if (this.recentMemory.length > 0) {
      lines.push(`• memory: ${formatMemoryActivities(this.recentMemory)}`);
    }
    if (delegateGroups.length > 0) {
      lines.push(`• agents: ${formatToolGroups(delegateGroups)}`);
    }
    if (context) {
      lines.push(`• context: ${formatContextStatus(context)}`);
    }

    const text = lines.join("\n");

    // Set before the awaited network call so concurrent flushes (e.g. a
    // heartbeat tick and an incoming tool event firing in the same turn) see
    // the updated timestamp and throttle correctly.
    this.lastUpdateTime = Date.now();

    if (this.messageTs) {
      await this.update(text);
    } else {
      await this.post(text);
    }
  }

  private async post(text: string): Promise<void> {
    try {
      const blocks = contextBlocks(text);
      const result = await this.transport.post(this.progressTarget.transportTarget, text, blocks);
      this.messageTs = result.ts;
      // Register immediately — this is the key to avoiding the race condition
      registerProgress(
        this.channel,
        this.threadTs,
        this.messageTs,
        this.transport,
        this.progressTarget.transportTarget,
      );
      logInfo(log, "progress_posted", { channel: this.channel, ts: this.messageTs });
    } catch (err) {
      logError(log, "post_error", err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns whether the edit landed, so callers can decide whether to drop
   * cleanup tracking. Transient failures are logged, not thrown. */
  private async update(text: string): Promise<boolean> {
    if (!this.messageTs) return false;
    try {
      const blocks = contextBlocks(text);
      await this.transport.update(
        this.progressTarget.transportTarget,
        this.messageTs,
        text,
        blocks,
      );
      return true;
    } catch (err) {
      logError(log, "update_error", err instanceof Error ? err.message : String(err));
      return false;
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
    ...(event.type === "session_error" ? { message: event.message } : {}),
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

  let session = activeSessions.get(key);
  if (!session) {
    session = new ProgressSession(target, transport);
    activeSessions.set(key, session);
  }
  session.setSourceTs(target.sourceTs);

  switch (event.type) {
    case "tool":
      await session.onToolCall(event.tool);
      break;
    case "memory":
      await session.onMemory({ action: event.action, path: event.path, source: event.source });
      break;
    case "delegate":
      await session.onDelegate({ agent: event.agent });
      break;
    case "session_error":
      session.onSessionError(event.message);
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
      await session.finish(event.status === "completed" ? "completed" : "error", event.error);
      activeSessions.delete(key);
      await onSessionEnd(target.key, target.key);
      break;
    }
  }
}
