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
  "diff-tree",
  "show",
  "show-branch",
  "show-ref",
  "rev-list",
  "rev-parse",
  "branch",
  "tag",
  "stash",
  "blame",
  "shortlog",
  "describe",
  "for-each-ref",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "cat-file",
  "cherry",
  "count-objects",
  "merge-base",
  "name-rev",
  "range-diff",
  "reflog",
  "grep",
  "help",
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
  // misc
  "version",
]);

export function validateGitArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const first = args[0];
  if (first.startsWith("-")) {
    return `"git ${first}" is not allowed — leading flags are not permitted; start with a bare subcommand`;
  }

  const subcommand = first.toLowerCase();
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === "checkout" || subcommand === "switch") {
      return `"git ${subcommand}" is not allowed — use 'git worktree add <path> <ref>' to work on another branch without leaving this worktree`;
    }
    return `"git ${subcommand}" is not allowed`;
  }

  // Restrict worktree add paths to /workspace/worktrees/
  if (subcommand === "worktree") {
    return validateGitWorktree(args);
  }

  // Restrict remote to read-only sub-subcommands
  if (subcommand === "remote") {
    return validateGitRemote(args);
  }

  // Restrict push to origin only (block pushing to arbitrary remotes/URLs)
  if (subcommand === "push") {
    return validateGitPush(args);
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

// ── git remote policy ──────────────────────────────────────────────────────

const ALLOWED_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "show",
  "get-url",
  "-v",
  "--verbose",
]);

function validateGitRemote(args: string[]): string | null {
  const remoteIdx = args.indexOf("remote");
  const subSub = args[remoteIdx + 1];

  // bare "git remote" (lists remotes) is allowed
  if (!subSub) return null;

  // -v/--verbose is a flag, not a sub-subcommand, but it's the common read case
  if (!ALLOWED_REMOTE_SUBCOMMANDS.has(subSub)) {
    return `"git remote ${subSub}" is not allowed — only read-only operations (show, get-url, -v) are permitted`;
  }

  return null;
}

// ── git push policy ────────────────────────────────────────────────────────

const ALLOWED_PUSH_FLAGS: ReadonlySet<string> = new Set([
  "--no-verify",
  "--dry-run",
  "-n",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
]);

const PUSH_FLAGS_ALLOWING_INLINE_VALUE: ReadonlySet<string> = new Set(["--force-with-lease"]);

function validateGitPush(args: string[]): string | null {
  const pushIdx = args.indexOf("push");

  let i = pushIdx + 1;
  let sawRemote = false;
  while (i < args.length) {
    const arg = args[i];

    const eqIdx = arg.indexOf("=");
    const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (ALLOWED_PUSH_FLAGS.has(arg)) {
      i += 1;
    } else if (PUSH_FLAGS_ALLOWING_INLINE_VALUE.has(flagName)) {
      i += 1;
    } else if (arg.startsWith("-")) {
      return `"git push ${arg}" is not allowed — unrecognized flag`;
    } else if (!sawRemote) {
      // First positional arg = remote
      if (arg !== "origin") {
        return `"git push ${arg}" is not allowed — only pushing to "origin" is permitted`;
      }
      sawRemote = true;
      i += 1;
    } else {
      const refspecError = validatePushRefspec(arg);
      if (refspecError) return refspecError;
      i += 1;
    }
  }

  // No remote specified — defaults to origin, which is fine
  return null;
}

function validatePushRefspec(refspec: string): string | null {
  if (refspec.startsWith("+")) {
    return `"git push ${refspec}" is not allowed — leading "+" force-updates via refspec; use --force-with-lease`;
  }

  const colonIdx = refspec.indexOf(":");
  if (colonIdx < 0) {
    return null;
  }

  const src = refspec.slice(0, colonIdx);
  const dst = refspec.slice(colonIdx + 1);

  if (src !== "HEAD") {
    return `"git push ${refspec}" is not allowed — mapped refspec source must be "HEAD"`;
  }

  if (!dst.startsWith("refs/heads/") || dst.length <= "refs/heads/".length) {
    return `"git push ${refspec}" is not allowed — mapped refspec destination must be "refs/heads/<branch>"`;
  }

  if (dst.includes(":")) {
    return `"git push ${refspec}" is not allowed — mapped refspec destination must not contain ":"`;
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

// ── langfuse policy ────────────────────────────────────────────────────────

const ALLOWED_LANGFUSE_RESOURCES: ReadonlySet<string> = new Set([
  "traces",
  "sessions",
  "observations",
  "metrics",
  "models",
  "prompts",
]);

const ALLOWED_LANGFUSE_ACTIONS: ReadonlySet<string> = new Set(["list", "get", "--help"]);

const DENIED_LANGFUSE_FLAGS: ReadonlySet<string> = new Set([
  "--config",
  "--output",
  "--output-file",
  "--curl",
  "--env",
  "--public-key",
  "--secret-key",
  "--host",
]);

export function validateLangfuseArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  // First arg must be "api"
  if (args[0] !== "api") {
    return `"langfuse ${args[0]}" is not allowed — only "langfuse api" is permitted`;
  }

  if (args.length < 2) {
    return '"langfuse api" requires a resource';
  }

  const resource = args[1];

  // __schema is a special case: no action required, no additional args
  if (resource === "__schema") {
    if (args.length > 2) {
      return '"langfuse api __schema" does not accept additional arguments';
    }
    return null;
  }

  if (!ALLOWED_LANGFUSE_RESOURCES.has(resource)) {
    return `"langfuse api ${resource}" is not allowed`;
  }

  if (args.length < 3) {
    return `"langfuse api ${resource}" requires an action (list, get, or --help)`;
  }

  const action = args[2];
  if (!ALLOWED_LANGFUSE_ACTIONS.has(action)) {
    return `"langfuse api ${resource} ${action}" is not allowed — only list, get, and --help are permitted`;
  }

  // Check for denied flags (handles both --flag value and --flag=value forms)
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (DENIED_LANGFUSE_FLAGS.has(flag)) {
      return `flag "${flag}" is not allowed`;
    }
  }

  return null;
}

// ── launchdarkly policy ────────────────────────────────────────────────────

const ALLOWED_LDCLI_RESOURCES: ReadonlySet<string> = new Set([
  "flags",
  "environments",
  "projects",
  "segments",
  "metrics",
]);

const ALLOWED_LDCLI_ACTIONS: ReadonlySet<string> = new Set(["list", "get", "--help"]);

const PROJECT_SCOPED_LDCLI_RESOURCES: ReadonlySet<string> = new Set([
  "flags",
  "environments",
  "segments",
  "metrics",
]);

const DENIED_LDCLI_FLAGS: ReadonlySet<string> = new Set([
  "--access-token",
  "--config",
  "--data",
  "--data-file",
  "--output-file",
  "--curl",
]);

export function validateLdcliArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const resource = args[0];
  if (!ALLOWED_LDCLI_RESOURCES.has(resource)) {
    return `"ldcli ${resource}" is not allowed`;
  }

  if (args.length < 2) {
    return `"ldcli ${resource}" requires an action (list, get, or --help)`;
  }

  const action = args[1];
  if (!ALLOWED_LDCLI_ACTIONS.has(action)) {
    return `"ldcli ${resource} ${action}" is not allowed — only list, get, and --help are permitted`;
  }

  if (resource === "metrics" && action === "get") {
    return '"ldcli metrics get" is not allowed — only "ldcli metrics list" is permitted';
  }

  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (DENIED_LDCLI_FLAGS.has(flag)) {
      return `flag "${flag}" is not allowed`;
    }
  }

  const isHelpRequest = args.includes("--help") || args.includes("-h");
  if (
    !isHelpRequest &&
    PROJECT_SCOPED_LDCLI_RESOURCES.has(resource) &&
    !hasOptionValue(args, "--project")
  ) {
    return `"ldcli ${resource} ${action}" requires "--project <key>"`;
  }

  return null;
}

function hasOptionValue(args: string[], option: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === option) {
      return Boolean(args[i + 1] && !args[i + 1].startsWith("-"));
    }

    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1).length > 0;
    }
  }

  return false;
}

// ── metabase policy ────────────────────────────────────────────────────────

const ALLOWED_METABASE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "schemas",
  "tables",
  "columns",
  "query",
]);

export function validateMetabaseArgs(args: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) {
    return "args must be a non-empty array";
  }

  const subcommand = args[0];
  if (!ALLOWED_METABASE_SUBCOMMANDS.has(subcommand)) {
    return `"metabase ${subcommand}" is not allowed — valid subcommands: schemas, tables, columns, query`;
  }

  const allowedSchemas = getMetabaseAllowedSchemas();

  if (subcommand === "schemas") {
    if (args.length > 1) return '"metabase schemas" takes no arguments';
    return null;
  }

  if (subcommand === "tables") {
    if (args.length !== 2) return '"metabase tables" requires exactly 1 argument: <schema>';
    const schema = args[1];
    if (allowedSchemas.size > 0 && !allowedSchemas.has(schema)) {
      return `schema "${schema}" is not in the allowed list`;
    }
    return null;
  }

  if (subcommand === "columns") {
    if (args.length !== 3)
      return '"metabase columns" requires exactly 2 arguments: <schema> <table>';
    const schema = args[1];
    if (allowedSchemas.size > 0 && !allowedSchemas.has(schema)) {
      return `schema "${schema}" is not in the allowed list`;
    }
    return null;
  }

  if (subcommand === "query") {
    if (args.length !== 2) return '"metabase query" requires exactly 1 argument: <sql>';
    return null;
  }

  return null;
}

function getMetabaseAllowedSchemas(): Set<string> {
  const raw = process.env.METABASE_ALLOWED_SCHEMAS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
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
  "pr review",
  "issue view",
  "issue list",
  "issue comment",
  "repo view",
  "run cancel",
  "run list",
  "run rerun",
  "run view",
  "workflow list",
  "workflow run",
  "workflow view",
  "label list",
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
    if (key === "pr checkout") {
      return `"gh ${key}" is not allowed — use 'git fetch origin pull/<N>/head:pr-<N>' then 'git worktree add <path> pr-<N>' to inspect a PR without leaving this worktree`;
    }
    return `"gh ${key}" is not allowed`;
  }

  return null;
}
