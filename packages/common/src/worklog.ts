/**
 * File-based work log.
 *
 * Writes one JSON file per event to a day-partitioned directory:
 *   ./worklog/2026-03-09/json/20260309T143021.456Z_tool-call_atlassian__list-issues.json
 *
 * The day directory (e.g. ./worklog/2026-03-09/) is reserved for higher-level
 * summary files; raw JSON event files go into the json/ subdirectory.
 *
 * Configurable via WORKLOG_DIR env var (defaults to ./worklog).
 * Set WORKLOG_ENABLED=false to disable (default: enabled).
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Max bytes for JSON-serialized args/result payloads. */
const MAX_PAYLOAD_BYTES = 4096;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncatePayload(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= MAX_PAYLOAD_BYTES) return value;
  return { _truncated: true, preview: json.slice(0, MAX_PAYLOAD_BYTES) };
}

/** Sanitize a string for use in a filename (replace non-alphanum with dash). */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function getWorklogDir(): string {
  return process.env.WORKLOG_DIR || "/workspace/worklog";
}

function isWorklogEnabled(): boolean {
  return process.env.WORKLOG_ENABLED !== "false";
}

/** Write a JSON file into the day-partitioned worklog/day/json/ directory. */
function writeEntry(filename: string, payload: Record<string, unknown>): void {
  if (!isWorklogEnabled()) return;

  try {
    const now = new Date();
    const jsonDir = join(getWorklogDir(), now.toISOString().slice(0, 10), "json");
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
// Tool call log (used by remote-cli MCP handling)
// ---------------------------------------------------------------------------

export interface ToolCallLogEntry {
  tool: string;
  decision: "allowed" | "blocked" | "pending" | "approved" | "rejected";
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
  const slug = sanitize(entry.tool);
  const filename = `${ts}_tool-call_${slug}.json`;

  writeEntry(filename, {
    timestamp: new Date().toISOString(),
    type: "tool_call",
    tool: entry.tool,
    decision: entry.decision,
    args: entry.args ? truncatePayload(entry.args) : undefined,
    result: entry.result ? truncatePayload(entry.result) : undefined,
    durationMs: entry.durationMs,
    error: entry.error,
  });
}

export interface InboundWebhookHistoryEntry {
  timestamp: string;
  route: string;
  provider: string;
  signatureVerified: boolean;
  parseStatus: string;
  requestId?: string;
  eventType?: string;
  action?: string;
  reason?: string;
  headers: Record<string, string | string[] | undefined>;
  payload?: unknown;
  rawBodyUtf8?: string;
  rawBodyBase64?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a JSONL line to a day-partitioned stream.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function appendJsonlWorklog(stream: string, entry: object): void {
  if (!isWorklogEnabled()) return;

  try {
    const now = new Date();
    const streamName = sanitize(stream).replace(/-+/g, "-");
    const jsonlDir = join(getWorklogDir(), now.toISOString().slice(0, 10), "jsonl");
    ensureDir(jsonlDir);
    appendFileSync(join(jsonlDir, `${streamName}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(
      `[worklog] Failed to append stream ${stream}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Write inbound webhook history to the durable JSONL stream.
 * Never throws — logs to stderr on failure so it doesn't break the caller.
 */
export function writeInboundWebhookHistory(entry: InboundWebhookHistoryEntry): void {
  appendJsonlWorklog("inbound-webhook-history", entry);
}
