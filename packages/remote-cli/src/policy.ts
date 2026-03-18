/**
 * Server-side command policy for git and gh.
 *
 * All validation happens here — the OpenCode wrapper scripts are untrusted.
 */

// ── cwd validation ──────────────────────────────────────────────────────────

const ALLOWED_CWD_PREFIXES = ["/workspace/repos", "/workspace/worktrees"];

export function validateCwd(cwd: string): string | null {
  if (!cwd || !cwd.startsWith("/")) {
    return "cwd must be an absolute path";
  }

  // Normalize to prevent traversal via /workspace/repos/../../etc
  const normalized = normalizePath(cwd);

  const allowed = ALLOWED_CWD_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + "/"),
  );

  if (!allowed) {
    return `cwd must be under ${ALLOWED_CWD_PREFIXES.join(" or ")}`;
  }

  return null;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      parts.pop();
    } else if (seg !== "" && seg !== ".") {
      parts.push(seg);
    }
  }
  return "/" + parts.join("/");
}

// ── git policy ──────────────────────────────────────────────────────────────

/**
 * Allowed git subcommands (allowlist — everything else is blocked).
 */
const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // read
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "stash",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "name-rev",
  "reflog",
  "grep",
  "submodule",
  // write (local) — no checkout/switch; agent stays on its assigned branch
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "restore",
  "rm",
  "mv",
  "clean",
  "apply",
  "am",
  // worktree
  "worktree",
  // remote (fetch/push/pull only)
  "fetch",
  "pull",
  "push",
  "remote",
  // config (read-only use; write is harmless to local .git/config)
  "config",
  // misc
  "version",
]);

export function validateGitArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  // Find the subcommand (skip flags like -C, -c, --git-dir etc.)
  const subcommand = findGitSubcommand(args);
  if (!subcommand) {
    return "no git subcommand found";
  }

  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())) {
    return `"git ${subcommand}" is not allowed`;
  }

  // Restrict worktree add paths to /workspace/worktrees/
  if (subcommand.toLowerCase() === "worktree") {
    return validateGitWorktree(args);
  }

  return null;
}

function findGitSubcommand(args: string[]): string | null {
  // Flags that consume the next argument
  const flagsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (flagsWithValue.has(arg)) {
      i += 2; // skip flag + value
    } else if (arg.startsWith("-")) {
      i += 1; // skip standalone flag
    } else {
      return arg; // first non-flag is the subcommand
    }
  }
  return null;
}

const WORKTREE_PREFIX = "/workspace/worktrees/";

function validateGitWorktree(args: string[]): string | null {
  // Find "worktree" then the sub-subcommand (add, list, remove, etc.)
  const wtIdx = args.indexOf("worktree");
  const subSub = args[wtIdx + 1];

  // "worktree add <path>" — validate the path
  if (subSub === "add") {
    // Find the path: first positional arg after "add" (skip flags)
    const path = findWorktreePath(args, wtIdx + 2);
    if (!path) {
      return '"git worktree add" requires a path';
    }
    const normalized = normalizePath(path);
    if (!normalized.startsWith(WORKTREE_PREFIX)) {
      return `worktree path must be under ${WORKTREE_PREFIX}`;
    }
  }

  return null;
}

function findWorktreePath(args: string[], startIdx: number): string | null {
  const flagsWithValue = new Set(["-b", "-B"]);
  let i = startIdx;
  while (i < args.length) {
    const arg = args[i];
    if (flagsWithValue.has(arg)) {
      i += 2;
    } else if (arg.startsWith("-")) {
      i += 1;
    } else {
      return arg;
    }
  }
  return null;
}

// ── scoutqa policy ──────────────────────────────────────────────────────────

const ALLOWED_SCOUTQA_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "create-execution",
  "send-message",
  "list-executions",
  "complete-execution",
  "auth",
]);

export function validateScoutqaArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const subcommand = args[0];
  if (!ALLOWED_SCOUTQA_SUBCOMMANDS.has(subcommand)) {
    return `"scoutqa ${subcommand}" is not allowed`;
  }

  // auth subcommand: only allow "status"
  if (subcommand === "auth") {
    const sub = args[1];
    if (sub !== "status") {
      return `"scoutqa auth ${sub || ""}" is not allowed — only "scoutqa auth status" is permitted`;
    }
  }

  return null;
}

// ── gh policy ───────────────────────────────────────────────────────────────

/**
 * Allowed gh CLI command groups and subcommands.
 * Format: "group subcommand" — e.g. "pr view", "issue list".
 */
const ALLOWED_GH_COMMANDS: ReadonlySet<string> = new Set([
  "pr view",
  "pr diff",
  "pr list",
  "pr status",
  "pr checks",
  "pr create",
  "pr edit",
  "pr comment",
  "pr ready",
  "issue view",
  "issue list",
  "issue comment",
  "repo view",
  "run list",
  "run view",
  "workflow list",
  "workflow view",
  "release list",
  "release view",
  "release download",
]);

export function validateGhArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const group = args[0];

  // gh api is blocked entirely — use specific gh commands instead
  if (group === "api") {
    return '"gh api" is not allowed — use specific gh commands (e.g. gh pr create, gh issue comment)';
  }

  const subcommand = args[1];
  if (!subcommand) {
    return `"gh ${group}" is not allowed — subcommand required`;
  }

  const key = `${group} ${subcommand}`;
  if (!ALLOWED_GH_COMMANDS.has(key)) {
    return `"gh ${key}" is not allowed`;
  }

  return null;
}
