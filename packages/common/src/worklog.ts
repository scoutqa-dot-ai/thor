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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKLOG_DIR = process.env.WORKLOG_DIR || "/workspace/worklog";
const WORKLOG_ENABLED = process.env.WORKLOG_ENABLED !== "false";

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
