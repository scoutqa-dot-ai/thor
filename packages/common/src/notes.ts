/**
 * Markdown notes — human-readable session memory.
 *
 * Each session (identified by correlation key) gets a markdown file that
 * accumulates trigger context and summaries across runs. The runner reads
 * this file on session resume to seed the agent with prior context.
 *
 * Directory structure:
 *   worklog/
 *   └─ 2026-03-10/
 *      ├─ json/         ← existing audit logs (unchanged)
 *      └─ notes/
 *         └─ my-session-key.md
 *
 * Notes files survive container restarts via bind mount.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WORKLOG_DIR = process.env.WORKLOG_DIR || "/worklog";

/** Sanitize a correlation key for use as a filename. */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
}

/** Get the notes directory for today. */
function todayNotesDir(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(WORKLOG_DIR, day, "notes");
}

/** Get the full path for a notes file in today's directory. */
function todayNotesPath(correlationKey: string): string {
  return join(todayNotesDir(), `${sanitizeKey(correlationKey)}.md`);
}

/**
 * Find the most recent notes file for a correlation key across all days.
 * Returns the path if found, undefined otherwise.
 *
 * Searches day directories in reverse chronological order (most recent first).
 */
export function findNotesFile(correlationKey: string): string | undefined {
  const filename = `${sanitizeKey(correlationKey)}.md`;

  try {
    const entries = readdirSync(WORKLOG_DIR, { withFileTypes: true });
    const days = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const day of days) {
      const candidate = join(WORKLOG_DIR, day, "notes", filename);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // worklog dir doesn't exist yet
  }

  return undefined;
}

/**
 * Read the contents of a notes file.
 * Returns the markdown content, or undefined if the file doesn't exist.
 */
export function readNotes(correlationKey: string): string | undefined {
  const path = findNotesFile(correlationKey);
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Create a new notes file with the initial trigger header.
 */
export function createNotes(opts: {
  correlationKey: string;
  prompt: string;
  model?: string;
  sessionId: string;
}): void {
  const dir = todayNotesDir();
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const content = `# Session: ${opts.correlationKey}
Created: ${now}
Session ID: ${opts.sessionId}

## Trigger
**Prompt**: ${opts.prompt}
**Model**: ${opts.model || "(default)"}
**Time**: ${now}
`;

  writeFileSync(todayNotesPath(opts.correlationKey), content);
}

/**
 * Append a follow-up trigger entry to an existing notes file.
 */
export function appendTrigger(opts: {
  correlationKey: string;
  prompt: string;
  model?: string;
}): void {
  const path = findNotesFile(opts.correlationKey);
  if (!path) return;

  const now = new Date().toISOString();
  const entry = `
---
## Follow-up — ${now}
**Prompt**: ${opts.prompt}
**Model**: ${opts.model || "(default)"}
`;

  try {
    const existing = readFileSync(path, "utf-8");
    writeFileSync(path, existing + entry);
  } catch {
    // File disappeared between find and write — skip
  }
}

/**
 * Append a session summary block to the notes file.
 */
export function appendSummary(opts: {
  correlationKey: string;
  status: "completed" | "error" | "timeout";
  durationMs: number;
  toolCalls: Array<{ tool: string; state: string }>;
  responsePreview?: string;
  error?: string;
}): void {
  const path = findNotesFile(opts.correlationKey);
  if (!path) return;

  const now = new Date().toISOString();

  const toolSummary =
    opts.toolCalls.length > 0 ? opts.toolCalls.map((t) => t.tool).join(", ") : "(none)";

  const durationSec = (opts.durationMs / 1000).toFixed(1);

  let entry = `
---
## Result — ${now}
**Status**: ${opts.status}
**Duration**: ${durationSec}s
**Tool calls**: ${opts.toolCalls.length} (${toolSummary})
`;

  if (opts.error) {
    entry += `**Error**: ${opts.error}\n`;
  }

  if (opts.responsePreview) {
    const preview =
      opts.responsePreview.length > 300
        ? opts.responsePreview.slice(0, 300) + "..."
        : opts.responsePreview;
    entry += `**Key findings**: ${preview}\n`;
  }

  try {
    const existing = readFileSync(path, "utf-8");
    writeFileSync(path, existing + entry);
  } catch {
    // skip
  }
}
