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
import { execFileSync } from "node:child_process";
import { z } from "zod/v4";

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
 * Register an alias for a correlation key.
 *
 * Appends a `### Session: {alias}` block to today's notes file for the
 * canonical correlation key. This allows events arriving with the alias
 * key to be resolved back to the canonical session.
 *
 * No-op if today's notes file does not exist for the canonical key.
 */
export function registerAlias(opts: {
  correlationKey: string;
  alias: string;
  context?: string;
}): void {
  // Skip self-alias (key and alias are the same)
  if (opts.correlationKey === opts.alias) return;

  const path = todayNotesPath(opts.correlationKey);
  if (!existsSync(path)) {
    console.warn(
      `[notes] registerAlias: no notes file for today, skipping (key=${opts.correlationKey})`,
    );
    return;
  }

  const entry = `
---
### Session: ${opts.alias}
${opts.context || `Alias for ${opts.correlationKey}`}
`;

  appendFileSync(path, entry);
}

// ---------------------------------------------------------------------------
// Alias extraction from tool call results
// ---------------------------------------------------------------------------

/** Discriminated union of tool artifacts that can produce aliases. */
const ToolArtifactSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("post_message"),
    input: z.object({
      channel: z.string().optional(),
      thread_ts: z.string().optional(),
    }),
    output: z.string(),
  }),
  z.object({
    tool: z.literal("git"),
    input: z.object({
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
    output: z.string(),
  }),
]);

type ToolArtifactUnion = z.infer<typeof ToolArtifactSchema>;

/** Loose input type — parsed into the discriminated union via safeParse. */
export interface ToolArtifact {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

/** An extracted alias ready to register. */
export interface ExtractedAlias {
  alias: string;
  context: string;
}

/** Tool names that can produce cross-channel aliases. */
const ALIASABLE_TOOLS = new Set(["post_message", "git"]);

/** Check if a tool name is aliasable. */
export function isAliasableTool(tool: string): boolean {
  return ALIASABLE_TOOLS.has(tool);
}

/** Zod schema for post_message JSON output. */
const PostMessageOutputSchema = z.object({
  ts: z.string().min(1),
  channel: z.string().optional(),
});

/**
 * Extract aliases from completed tool call artifacts.
 *
 * Each tool has specific extraction logic:
 * - `post_message`: new thread → `slack:thread:{ts}`, reply → `slack:thread:{thread_ts}`
 * - `git` with push: → `git:branch:{repo}:{branch}`
 *
 * Best-effort: malformed artifacts are silently skipped via Zod safeParse.
 */
export function extractAliases(artifacts: ToolArtifact[]): ExtractedAlias[] {
  const aliases: ExtractedAlias[] = [];

  for (const raw of artifacts) {
    try {
      const parsed = ToolArtifactSchema.safeParse(raw);
      if (!parsed.success) continue;

      const artifact: ToolArtifactUnion = parsed.data;

      switch (artifact.tool) {
        case "post_message": {
          const channel = artifact.input.channel || "unknown";

          if (artifact.input.thread_ts) {
            // Reply to existing thread — alias the thread so future events route here
            aliases.push({
              alias: `slack:thread:${artifact.input.thread_ts}`,
              context: `Replied in thread in ${channel}`,
            });
          } else {
            // New thread — alias the new message ts
            const output = PostMessageOutputSchema.safeParse(JSON.parse(artifact.output));
            if (!output.success) break;

            const resolvedChannel = output.data.channel || channel;
            aliases.push({
              alias: `slack:thread:${output.data.ts}`,
              context: `New thread posted to ${resolvedChannel}`,
            });
          }
          break;
        }

        case "git": {
          const { args, cwd } = artifact.input;
          const branch = extractBranchFromGitArgs(args);
          if (!branch) break;

          const repo = inferRepoFromPath(cwd || "");
          if (!repo) break;

          const subcommand = args[0];
          aliases.push({
            alias: `git:branch:${repo}:${branch}`,
            context: `git ${subcommand} in ${cwd || "(default cwd)"}`,
          });
          break;
        }
      }
    } catch {
      // Best-effort: skip malformed output (e.g. JSON.parse failure)
    }
  }

  return aliases;
}

/**
 * Infer repo identifier from a local path.
 * Convention: /workspace/repos/{owner}-{repo} → {owner}/{repo}
 *             /workspace/repos/{repo}         → {repo}
 */
function inferRepoFromPath(cwdPath: string): string | undefined {
  if (!cwdPath) return undefined;
  // Match /workspace/repos/{name} or deeper worktree paths
  const match = cwdPath.match(/\/workspace\/repos\/([^/]+)/);
  if (!match) return undefined;
  const dirName = match[1];
  // Convention: first hyphen separates owner from repo (e.g., "acme-project" → "acme/project")
  const hyphenIdx = dirName.indexOf("-");
  if (hyphenIdx > 0) {
    return `${dirName.slice(0, hyphenIdx)}/${dirName.slice(hyphenIdx + 1)}`;
  }
  return dirName;
}

/**
 * Extract a branch name from git command args.
 *
 * Supported patterns:
 * - push origin <branch>        → branch
 * - push origin HEAD:<ref>      → ref (stripped of refs/heads/)
 * - checkout <branch>           → branch
 * - checkout -b <branch>        → branch
 * - switch <branch>             → branch
 * - switch -c <branch>          → branch
 *
 * Returns undefined for unrecognized patterns.
 */
function extractBranchFromGitArgs(args: string[]): string | undefined {
  if (args.length < 2) return undefined;
  const subcommand = args[0];

  if (subcommand === "push") {
    // git push origin <branch> or git push origin HEAD:refs/heads/<branch>
    const positional = args.slice(1).filter((a) => !a.startsWith("-"));
    // positional: ["origin", "branch"] or ["origin", "HEAD:refs/heads/branch"]
    const raw = positional.length >= 2 ? positional[positional.length - 1] : undefined;
    if (!raw) return undefined;
    const ref = raw.includes(":") ? raw.split(":").pop()! : raw;
    return ref.replace(/^refs\/heads\//, "");
  }

  if (subcommand === "checkout" || subcommand === "switch") {
    // Last positional arg that isn't a flag, skipping flag values like -b/-c
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-b" || args[i] === "-c" || args[i] === "-B" || args[i] === "-C") {
        i++; // skip the flag's value (the next arg is the branch name, add it)
        if (i < args.length) positional.push(args[i]);
      } else if (args[i].startsWith("-")) {
        // skip other flags (--track, --no-track, etc.)
      } else {
        positional.push(args[i]);
      }
    }
    const branch = positional[0];
    if (!branch) return undefined;
    // Strip remote prefix: origin/feat/x → feat/x
    return branch.replace(/^origin\//, "");
  }

  return undefined;
}

/**
 * Resolve a raw correlation key to its canonical key.
 *
 * Scans all notes files for a `# Session:` (h1) or `### Session:` (h3)
 * line matching the raw key. If found, reads the file's h1 line to
 * return the canonical key.
 *
 * Always scans first (no fast-path direct lookup) because a key may have
 * been aliased to a newer session — direct lookup would find the old file.
 *
 * Returns the raw key unchanged if no match is found.
 */
export function resolveCorrelationKey(rawKey: string): string {
  try {
    const aliasFile = grepNotesFiles(`^### Session: ${escapeRegExp(rawKey)}$`);
    if (aliasFile) {
      const canonical = extractH1Key(aliasFile);
      if (canonical) return canonical;
    }
  } catch {
    // worklog dir doesn't exist yet or grep not available
  }

  return rawKey;
}

/**
 * Run grep across all notes files, returning the first matching file path.
 * Returns undefined if no match or grep fails.
 */
function grepNotesFiles(pattern: string): string | undefined {
  try {
    const result = execFileSync("grep", ["-rl", "-m", "1", "--include=*.md", "-E", pattern, "."], {
      cwd: WORKLOG_DIR,
      encoding: "utf-8",
      timeout: 5000,
    });
    const firstLine = result.trim().split("\n")[0];
    return firstLine ? join(WORKLOG_DIR, firstLine) : undefined;
  } catch {
    // grep returns exit code 1 for no matches, or WORKLOG_DIR doesn't exist
    return undefined;
  }
}

/** Extract the canonical correlation key from the h1 `# Session:` line. */
function extractH1Key(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^# Session: (.+?)(?:\s*\(continued\))?$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count the number of lines in a notes file.
 * Returns 0 if the file doesn't exist or can't be read.
 */
export function getNotesLineCount(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
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
