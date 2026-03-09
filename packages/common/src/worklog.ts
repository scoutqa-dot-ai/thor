/**
 * File-based work log.
 *
 * Writes one JSON file per event to a day-partitioned directory:
 *   ./worklog/2026-03-09/json/20260309T143021.456Z_tool-call_linear__list-issues.json
 *
 * The day directory (e.g. ./worklog/2026-03-09/) is reserved for higher-level
 * summary files; raw JSON event files go into the json/ subdirectory.
 *
 * Configurable via WORKLOG_DIR env var (defaults to ./worklog).
 * Set WORKLOG_ENABLED=false to disable (default: enabled).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKLOG_DIR = process.env.WORKLOG_DIR || "./worklog";
const WORKLOG_ENABLED = process.env.WORKLOG_ENABLED !== "false";

/** Max bytes for JSON-serialized args/result payloads. */
const MAX_PAYLOAD_BYTES = 4096;

/** Max bytes for text content. */
const MAX_TEXT_BYTES = 8192;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncatePayload(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= MAX_PAYLOAD_BYTES) return value;
  return { _truncated: true, preview: json.slice(0, MAX_PAYLOAD_BYTES) };
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_BYTES) return text;
  return text.slice(0, MAX_TEXT_BYTES) + "\n...[truncated]";
}

/** Sanitize a string for use in a filename (replace non-alphanum with dash). */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write a JSON file into the day-partitioned worklog/day/json/ directory. */
function writeEntry(filename: string, payload: Record<string, unknown>): void {
  if (!WORKLOG_ENABLED) return;

  try {
    const now = new Date();
    const jsonDir = join(WORKLOG_DIR, now.toISOString().slice(0, 10), "json");
    ensureDir(jsonDir);
    writeFileSync(join(jsonDir, filename), JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    console.error(
      `[worklog] Failed to write ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** ISO timestamp with colons removed, safe for filenames. */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "");
}

// ---------------------------------------------------------------------------
// Tool call log (used by the proxy)
// ---------------------------------------------------------------------------

export interface ToolCallLogEntry {
  upstream: string;
  tool: string;
  proxyToolName: string;
  decision: "allowed" | "blocked";
  args?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

/**
 * Write a tool call log file.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function writeToolCallLog(entry: ToolCallLogEntry): void {
  const ts = fileTimestamp();
  const slug = sanitize(entry.proxyToolName);
  const filename = `${ts}_tool-call_${slug}.json`;

  writeEntry(filename, {
    timestamp: new Date().toISOString(),
    type: "tool_call",
    upstream: entry.upstream,
    tool: entry.tool,
    proxyToolName: entry.proxyToolName,
    decision: entry.decision,
    args: entry.args ? truncatePayload(entry.args) : undefined,
    result: entry.result ? truncatePayload(entry.result) : undefined,
    durationMs: entry.durationMs,
    error: entry.error,
  });
}

// ---------------------------------------------------------------------------
// Part-level log (used by the runner in streaming mode)
// ---------------------------------------------------------------------------

/**
 * Log entry for a single Part from a `message.part.updated` SSE event.
 * Each Part becomes one JSON file, giving real-time visibility into agent work.
 */
export interface PartLogEntry {
  sessionId: string;
  messageId: string;
  partId: string;
  partType: string;

  /** Text content (for text/reasoning parts). */
  text?: string;

  /** Tool information (for tool parts). */
  tool?: {
    callId: string;
    name: string;
    status: string;
    input?: unknown;
    output?: string;
    error?: string;
    durationMs?: number;
  };

  /** Step finish information (for step-finish parts). */
  stepFinish?: {
    reason: string;
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  };

  /** Sequence counter within the session (monotonically increasing). */
  seq: number;
}

/**
 * Write a part-level log file for a single SSE message.part.updated event.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function writePartLog(entry: PartLogEntry): void {
  const ts = fileTimestamp();
  const shortSession = entry.sessionId.slice(0, 8);
  const seqStr = String(entry.seq).padStart(4, "0");
  const filename = `${ts}_part_${shortSession}_${seqStr}_${sanitize(entry.partType)}.json`;

  writeEntry(filename, {
    timestamp: new Date().toISOString(),
    type: "part",
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    partId: entry.partId,
    partType: entry.partType,
    seq: entry.seq,
    text: entry.text ? truncateText(entry.text) : undefined,
    tool: entry.tool
      ? {
          ...entry.tool,
          input: entry.tool.input ? truncatePayload(entry.tool.input) : undefined,
          output: entry.tool.output ? truncateText(entry.tool.output) : undefined,
        }
      : undefined,
    stepFinish: entry.stepFinish,
  });
}

// ---------------------------------------------------------------------------
// Session summary log (written once when a session completes)
// ---------------------------------------------------------------------------

export interface SessionSummaryLog {
  sessionId: string;
  status: "completed" | "error" | "timeout";
  prompt: string;
  responseText?: string;
  totalToolCalls: number;
  totalParts: number;
  durationMs: number;
  error?: string;
  /** Aggregated token/cost from step-finish parts. */
  totals?: {
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  };
}

/**
 * Write a session summary log file.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function writeSessionSummaryLog(entry: SessionSummaryLog): void {
  const ts = fileTimestamp();
  const shortSession = entry.sessionId.slice(0, 8);
  const filename = `${ts}_session_${shortSession}_summary.json`;

  writeEntry(filename, {
    timestamp: new Date().toISOString(),
    type: "session_summary",
    sessionId: entry.sessionId,
    status: entry.status,
    prompt: truncateText(entry.prompt),
    responseText: entry.responseText ? truncateText(entry.responseText) : undefined,
    totalToolCalls: entry.totalToolCalls,
    totalParts: entry.totalParts,
    durationMs: entry.durationMs,
    error: entry.error,
    totals: entry.totals,
  });
}

// ---------------------------------------------------------------------------
// Trigger log (written at the start of a prompt)
// ---------------------------------------------------------------------------

export interface TriggerLogEntry {
  sessionId: string;
  prompt: string;
  model?: string;
}

/**
 * Write a trigger log file when a new prompt is sent.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function writeTriggerLog(entry: TriggerLogEntry): void {
  const ts = fileTimestamp();
  const shortSession = entry.sessionId.slice(0, 8);
  const filename = `${ts}_trigger_${shortSession}.json`;

  writeEntry(filename, {
    timestamp: new Date().toISOString(),
    type: "trigger",
    sessionId: entry.sessionId,
    prompt: truncateText(entry.prompt),
    model: entry.model,
  });
}
