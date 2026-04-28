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
import { truncate } from "./logger.js";
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
}): boolean {
  const target = todayNotesPath(opts.correlationKey);
  if (existsSync(target)) return false;

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
  return true;
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
const ALIASABLE_TOOLS = new Set(["slack_post_message", "bash"]);

/** Check if a tool name is aliasable. */
export function isAliasableTool(tool: string): boolean {
  return ALIASABLE_TOOLS.has(tool);
}

/** Git subcommands that produce branch aliases worth tracking. */
const ALIASABLE_GIT_SUBCOMMANDS = new Set(["push", "checkout", "switch", "worktree"]);

/** Check if a git/gh command's args represent an aliasable branch operation. */
export function isAliasableGitCommand(args: string[]): boolean {
  return args.length > 0 && ALIASABLE_GIT_SUBCOMMANDS.has(args[0]);
}

/** MCP tool names that produce aliases worth tracking. */
const ALIASABLE_MCP_TOOLS = new Set(["post_message"]);

/** Check if an MCP tool name produces aliases worth tracking. */
export function isAliasableMcpTool(tool: string): boolean {
  return ALIASABLE_MCP_TOOLS.has(tool);
}

/** Zod schema for slack_post_message input. */
const SlackPostMessageInput = z.object({
  channel: z.string().optional(),
  thread_ts: z.string().optional(),
});

/** Zod schema for slack_post_message JSON output. */
const SlackPostMessageOutput = z.object({
  ts: z.string().min(1),
  channel: z.string().optional(),
});

/**
 * Extract aliases from completed tool call artifacts.
 *
 * Two sources:
 * - `bash` with [thor:meta]: pre-computed aliases from service-side helpers
 * - `slack_post_message`: direct MCP tool (not proxied through bash)
 *
 * Best-effort: malformed artifacts are silently skipped.
 */
export function extractAliases(artifacts: ToolArtifact[]): ExtractedAlias[] {
  const aliases: ExtractedAlias[] = [];

  for (const raw of artifacts) {
    try {
      if (raw.tool === "bash") {
        // [thor:meta] lines contain pre-computed aliases from the service layer
        for (const meta of extractThorMeta(raw.output)) {
          if (meta.type === "alias") {
            aliases.push({ alias: meta.alias, context: meta.context });
          }
        }
        continue;
      }

      if (raw.tool === "slack_post_message") {
        const input = SlackPostMessageInput.safeParse(raw.input);
        if (!input.success) continue;

        const channel = input.data.channel || "unknown";

        if (input.data.thread_ts) {
          aliases.push({
            alias: `slack:thread:${input.data.thread_ts}`,
            context: `Replied in thread in ${channel}`,
          });
        } else {
          const output = SlackPostMessageOutput.safeParse(JSON.parse(raw.output));
          if (!output.success) continue;

          const resolvedChannel = output.data.channel || channel;
          aliases.push({
            alias: `slack:thread:${output.data.ts}`,
            context: `New thread posted to ${resolvedChannel}`,
          });
        }
        continue;
      }
    } catch {
      // Best-effort: skip malformed output (e.g. JSON.parse failure)
    }
  }

  return aliases;
}

/**
 * Schemas for [thor:meta] JSON payloads emitted to stderr by service layers.
 *
 * Discriminated union on `type`:
 * - `alias`: pre-computed correlation alias (git branch, Slack thread, etc.)
 * - `approval`: approval-required signal from remote-cli MCP handling
 *
 * Producer: remote-cli service.
 * Consumer: extractThorMeta() in this module.
 */
export const ThorMetaAliasSchema = z.object({
  type: z.literal("alias"),
  alias: z.string(),
  context: z.string(),
});

export const ThorMetaApprovalSchema = z.object({
  type: z.literal("approval"),
  actionId: z.string(),
  proxyName: z.string(),
  tool: z.string(),
});

export const ThorMetaSchema = z.discriminatedUnion("type", [
  ThorMetaAliasSchema,
  ThorMetaApprovalSchema,
]);

export type ThorMetaAlias = z.infer<typeof ThorMetaAliasSchema>;
export type ThorMetaApproval = z.infer<typeof ThorMetaApprovalSchema>;
export type ThorMeta = z.infer<typeof ThorMetaSchema>;

/**
 * Extract all [thor:meta] entries from tool output.
 * Returns parsed metadata objects; malformed lines are silently skipped.
 */
export function extractThorMeta(output: string): ThorMeta[] {
  const results: ThorMeta[] = [];
  const regex = /\[thor:meta]\s*(.+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    try {
      const parsed = ThorMetaSchema.safeParse(JSON.parse(match[1]));
      if (parsed.success) results.push(parsed.data);
    } catch {
      // skip malformed JSON
    }
  }
  return results;
}

/**
 * Infer repo identifier from a local path.
 * Matches both /workspace/repos/{name} and /workspace/worktrees/{name}/...
 * Returns just the directory name (no owner prefix) — the gateway emits
 * a short alias using the same repo-name-only format so they match.
 */
export function inferRepoFromPath(cwdPath: string): string | undefined {
  if (!cwdPath) return undefined;
  // Match /workspace/repos/{name} or /workspace/worktrees/{name}
  const match = cwdPath.match(/\/workspace\/(?:repos|worktrees)\/([^/]+)/);
  if (!match) return undefined;
  return match[1];
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
 * - worktree add [-b <branch>] <path> [<commit-ish>]
 *
 * Returns undefined for unrecognized patterns.
 */
export function extractBranchFromGitArgs(args: string[]): string | undefined {
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

  // git worktree add [-b <branch>] <path> [<commit-ish>]
  if (subcommand === "worktree" && args[1] === "add") {
    const wtArgs = args.slice(2);
    for (let i = 0; i < wtArgs.length; i++) {
      if (wtArgs[i] === "-b" || wtArgs[i] === "-B") {
        return wtArgs[i + 1]; // branch name follows -b
      }
    }
    // No -b: branch is inferred from <path> basename or <commit-ish>
    const positional = wtArgs.filter((a) => !a.startsWith("-"));
    // positional[0] = path, positional[1] = commit-ish (often a branch name)
    if (positional[1]) return positional[1].replace(/^origin\//, "");
    // Fallback: basename of the worktree path
    if (positional[0]) {
      const base = positional[0].split("/").pop();
      if (base) return base;
    }
    return undefined;
  }

  return undefined;
}

/**
 * Build a [thor:meta] line from a typed payload.
 * Produces the string that services embed in stderr.
 */
export function formatThorMeta(meta: ThorMeta): string {
  return `\n[thor:meta] ${JSON.stringify(meta)}\n`;
}

/**
 * Compute a git branch alias from command args and cwd.
 * Returns a ThorMetaAlias or undefined if not aliasable.
 */
export function computeGitAlias(
  cmd: "git" | "gh",
  args: string[],
  cwd: string,
): ThorMetaAlias | undefined {
  if (!isAliasableGitCommand(args)) return undefined;
  const branch = extractBranchFromGitArgs(args);
  if (!branch) return undefined;
  const repo = inferRepoFromPath(cwd);
  if (!repo) return undefined;
  return {
    type: "alias",
    alias: `git:branch:${repo}:${branch}`,
    context: `${cmd} ${args[0]} in ${cwd}`,
  };
}

/**
 * Compute a Slack thread alias from post_message tool call.
 * Returns a ThorMetaAlias or undefined if not aliasable.
 */
export function computeSlackAlias(
  toolArgs: Record<string, unknown>,
  result: string,
): ThorMetaAlias | undefined {
  const channel = (toolArgs.channel as string) || "unknown";

  if (toolArgs.thread_ts) {
    return {
      type: "alias",
      alias: `slack:thread:${toolArgs.thread_ts}`,
      context: `Replied in thread in ${channel}`,
    };
  }

  try {
    const output = SlackPostMessageOutput.safeParse(JSON.parse(result));
    if (!output.success) return undefined;
    return {
      type: "alias",
      alias: `slack:thread:${output.data.ts}`,
      context: `New thread posted to ${output.data.channel || channel}`,
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve one or more candidate correlation keys, returning the most recent match.
 *
 * Scans all notes files for `### Session:` (h3 alias) and `# Session:`
 * (h1 canonical) lines matching each key. When multiple files match,
 * the most recent file (by directory date in the path) wins.
 *
 * Falls back to the first key if nothing resolves.
 */
export function resolveCorrelationKeys(rawKeys: string[]): string {
  if (rawKeys.length === 0) return "";

  const candidates: Array<{ canonical: string; file: string }> = [];

  for (const key of rawKeys) {
    try {
      // Check as alias (h3)
      const aliasFiles = grepAllNotesFiles(`^### Session: ${escapeRegExp(key)}$`);
      for (const f of aliasFiles) {
        const canonical = extractH1Key(f);
        if (canonical) candidates.push({ canonical, file: f });
      }

      // Check as canonical (h1)
      const h1Files = grepAllNotesFiles(`^# Session: ${escapeRegExp(key)}(\\s*\\(continued\\))?$`);
      for (const f of h1Files) {
        candidates.push({ canonical: key, file: f });
      }
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) return rawKeys[0];

  // Pick the most recent by file path (paths contain date: worklog/2026-03-17/notes/...)
  candidates.sort((a, b) => b.file.localeCompare(a.file));
  return candidates[0].canonical;
}

/**
 * Run grep across all notes files, returning the first matching file path.
 * Returns undefined if no match or grep fails.
 */
function grepNotesFiles(pattern: string): string | undefined {
  const files = grepAllNotesFiles(pattern);
  return files.length > 0 ? files[0] : undefined;
}

/**
 * Run grep across all notes files, returning all matching file paths.
 * Returns empty array if no match or grep fails.
 */
function grepAllNotesFiles(pattern: string): string[] {
  try {
    const result = execFileSync("grep", ["-rl", "--include=*.md", "-E", pattern, "."], {
      cwd: WORKLOG_DIR,
      encoding: "utf-8",
      timeout: 5000,
    });
    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => join(WORKLOG_DIR, line));
  } catch {
    // grep returns exit code 1 for no matches, or WORKLOG_DIR doesn't exist
    return [];
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

/**
 * Check if Thor is engaged in a Slack thread for this correlation key.
 *
 * Matches both the h1 canonical key (`# Session: slack:thread:…`) for
 * threads initiated by @mention, and h3 aliases (`### Session: slack:thread:…`)
 * for threads created by cron/github sessions that posted into Slack.
 */
export function hasSlackReply(correlationKey: string): boolean {
  const path = findNotesFile(correlationKey);
  if (!path) return false;
  try {
    const content = readFileSync(path, "utf-8");
    return content.includes("# Session: slack:thread:");
  } catch {
    return false;
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
    const preview = truncate(opts.responsePreview, 300);
    entry += `**Key findings**: ${preview}\n`;
  }

  appendFileSync(path, entry);
}
