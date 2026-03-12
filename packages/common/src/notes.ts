/**
 * Markdown notes — human-readable session memory.
 *
 * Each session (identified by correlation key) gets a markdown file per day.
 * On cross-day resume, a new file is created for today with a back-reference
 * to the previous day's file — the old file is never modified.
 *
 * Directory structure:
 *   worklog/
 *   ├─ 2026-03-10/
 *   │  └─ notes/
 *   │     └─ my-session-key.md   ← frozen after that day
 *   └─ 2026-03-11/
 *      └─ notes/
 *         └─ my-session-key.md   ← continuation with back-reference
 *
 * Write operations (appendTrigger, appendSummary) always target today's file
 * without scanning previous days — fast and side-effect-free on old files.
 *
 * Notes files survive container restarts via bind mount.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";

const WORKLOG_DIR = process.env.WORKLOG_DIR || "/workspace/worklog";

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
 * Roll a session forward into today's notes file.
 *
 * Called when a cross-day resume is detected: creates a new notes file for
 * today with a back-reference to the previous day's file. The old file is
 * never modified. Subsequent appendTrigger/appendSummary calls will target
 * today's file automatically.
 *
 * If today's file already exists (e.g., duplicate trigger), this is a no-op.
 */
export function continueNotes(opts: {
  correlationKey: string;
  sessionId: string;
  prompt: string;
  model?: string;
  previousNotesPath: string;
}): void {
  const target = todayNotesPath(opts.correlationKey);
  if (existsSync(target)) return;

  const dir = todayNotesDir();
  mkdirSync(dir, { recursive: true });

  const backRef = relative(dir, opts.previousNotesPath);
  const now = new Date().toISOString();

  const content = `# Session: ${opts.correlationKey} (continued)
Created: ${now}
Session ID: ${opts.sessionId}
Previous: ${backRef}

## Follow-up — ${now}
**Prompt**: ${opts.prompt}
**Model**: ${opts.model || "(default)"}
`;

  writeFileSync(target, content);
}

/**
 * Append a follow-up trigger entry to today's notes file.
 * Always writes to today's path — never touches previous days' files.
 * No-op if today's notes file does not exist (call createNotes or continueNotes first).
 */
export function appendTrigger(opts: {
  correlationKey: string;
  prompt: string;
  model?: string;
}): void {
  const path = todayNotesPath(opts.correlationKey);
  if (!existsSync(path)) {
    console.warn(
      `[notes] appendTrigger: no notes file for today, skipping (key=${opts.correlationKey})`,
    );
    return;
  }

  const now = new Date().toISOString();
  const entry = `
---
## Follow-up — ${now}
**Prompt**: ${opts.prompt}
**Model**: ${opts.model || "(default)"}
`;

  appendFileSync(path, entry);
}

/**
 * Extract the session ID from a notes file for a given correlation key.
 * Reads the `Session ID: <id>` line from the header.
 * Returns undefined if no notes file exists or no session ID is found.
 */
export function getSessionIdFromNotes(correlationKey: string): string | undefined {
  const path = findNotesFile(correlationKey);
  if (!path) return undefined;
  try {
    const content = readFileSync(path, "utf-8");
    const match = content.match(/^Session ID:\s*(.+)$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append a session summary block to today's notes file.
 * Always writes to today's path — never touches previous days' files.
 * No-op if today's notes file does not exist.
 */
export function appendSummary(opts: {
  correlationKey: string;
  status: "completed" | "error" | "timeout";
  durationMs: number;
  toolCalls: Array<{ tool: string; state: string }>;
  responsePreview?: string;
  error?: string;
}): void {
  const path = todayNotesPath(opts.correlationKey);
  if (!existsSync(path)) {
    console.warn(
      `[notes] appendSummary: no notes file for today, skipping (key=${opts.correlationKey})`,
    );
    return;
  }

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

  appendFileSync(path, entry);
}
