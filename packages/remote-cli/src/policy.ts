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
  "-u",
  "--set-upstream",
  "--no-verify",
  "--dry-run",
  "-n",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
]);

const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

function validateGitPush(args: string[]): string | null {
  const pushIdx = args.indexOf("push");

  let i = pushIdx + 1;
  let sawRemote = false;
  let sawRefspec = false;
  while (i < args.length) {
    const arg = args[i];

    if (ALLOWED_PUSH_FLAGS.has(arg)) {
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
      sawRefspec = true;
      i += 1;
    }
  }

  if (!sawRemote) {
    return '"git push" is not allowed — must explicitly specify remote "origin"';
  }

  if (!sawRefspec) {
    return '"git push origin" is not allowed — must include an explicit branch or refspec';
  }

  return null;
}

function validatePushRefspec(refspec: string): string | null {
  if (refspec.startsWith("+")) {
    return `"git push ${refspec}" is not allowed — leading "+" force-updates via refspec are blocked`;
  }

  const colonIdx = refspec.indexOf(":");
  if (colonIdx < 0) {
    if (refspec === "HEAD") {
      return `"git push ${refspec}" is not allowed — refspec must target an explicit destination branch`;
    }

    const branch = refspec.startsWith("refs/heads/")
      ? refspec.slice("refs/heads/".length)
      : refspec;
    if (PROTECTED_PUSH_BRANCHES.has(branch)) {
      return `"git push ${refspec}" is not allowed — pushing to protected branch "${branch}" is blocked`;
    }

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

  const dstBranch = dst.slice("refs/heads/".length);
  if (PROTECTED_PUSH_BRANCHES.has(dstBranch)) {
    return `"git push ${refspec}" is not allowed — pushing to protected branch "${dstBranch}" is blocked`;
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
  "pr comment",
  "pr review",
  "issue view",
  "issue list",
  "issue comment",
  "repo view",
  "run list",
  "run view",
  "workflow list",
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

  if (key === "pr create") {
    return validateGhPrCreateArgs(args);
  }

  if (key === "pr comment" || key === "issue comment") {
    return validateGhAppendOnlyCommentArgs(args, key);
  }

  if (key === "pr review") {
    return validateGhPrReviewArgs(args);
  }

  return null;
}

function validateGhPrCreateArgs(args: string[]): string | null {
  const key = "pr create";
  const allowedFlagsWithValue: ReadonlySet<string> = new Set([
    "-t",
    "--title",
    "-b",
    "--body",
    "-B",
    "--base",
    "-H",
    "--head",
  ]);

  const allowedBooleanFlags: ReadonlySet<string> = new Set(["--draft"]);

  const blockedFlags: ReadonlySet<string> = new Set([
    "-e",
    "--editor",
    "-w",
    "--web",
    "-F",
    "--body-file",
  ]);

  let hasTitle = false;
  let hasBody = false;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (blockedFlags.has(flag)) {
      return `"gh ${key} ${flag}" is not allowed — interactive and file-based modes are blocked`;
    }

    if (allowedBooleanFlags.has(flag)) {
      continue;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --title/--body with optional --base/--head/--draft are permitted`;
    }

    if (flag === "-t" || flag === "--title") {
      hasTitle = true;
    }
    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      i += 1;
    }
  }

  if (!hasTitle || !hasBody) {
    return '"gh pr create" requires both --title and --body';
  }

  return null;
}

function validateGhAppendOnlyCommentArgs(args: string[], key: string): string | null {
  const allowedFlagsWithValue: ReadonlySet<string> = new Set(["-b", "--body"]);

  const blockedMutationFlags: ReadonlySet<string> = new Set([
    "--edit-last",
    "--delete-last",
    "--create-if-none",
    "--yes",
    "-e",
    "--editor",
    "-w",
    "--web",
    "-F",
    "--body-file",
  ]);

  let hasBody = false;
  const selectors: string[] = [];

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      selectors.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (blockedMutationFlags.has(flag)) {
      return `"gh ${key} ${flag}" is not allowed — append-only comment creation only`;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --body is permitted`;
    }

    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      i += 1;
    }
  }

  if (!hasBody) {
    return `"gh ${key}" requires --body`;
  }

  if (key === "pr comment") {
    return validateOptionalNumericSelector(key, selectors, "PR");
  }

  // issue comment must always include a numeric issue number selector
  return validateRequiredNumericSelector(key, selectors, "issue");
}

function validateOptionalNumericSelector(
  key: string,
  selectors: string[],
  resourceName: string,
): string | null {
  if (selectors.length > 1) {
    return `"gh ${key}" allows at most one positional ${resourceName} number selector`;
  }

  if (selectors.length === 1 && !/^\d+$/.test(selectors[0])) {
    return `"gh ${key}" positional selector must be a numeric ${resourceName} number`;
  }

  return null;
}

function validateRequiredNumericSelector(
  key: string,
  selectors: string[],
  resourceName: string,
): string | null {
  if (selectors.length !== 1) {
    return `"gh ${key}" requires exactly one positional ${resourceName} number selector`;
  }

  if (!/^\d+$/.test(selectors[0])) {
    return `"gh ${key}" positional selector must be a numeric ${resourceName} number`;
  }

  return null;
}

function validateGhPrReviewArgs(args: string[]): string | null {
  const key = "pr review";
  const allowedFlagsWithValue: ReadonlySet<string> = new Set(["-b", "--body"]);

  const allowedModeFlags: ReadonlySet<string> = new Set(["-c", "--comment", "-r", "--request-changes"]);

  let sawCommentMode = false;
  let sawRequestChangesMode = false;
  let hasBody = false;
  const selectors: string[] = [];

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      selectors.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (flag === "-a" || flag === "--approve") {
      return '"gh pr review --approve" is not allowed — PR approval must be human';
    }

    if (
      flag === "-e" ||
      flag === "--editor" ||
      flag === "-w" ||
      flag === "--web" ||
      flag === "-F" ||
      flag === "--body-file"
    ) {
      return `"gh ${key} ${flag}" is not allowed — interactive and file-based review modes are blocked`;
    }

    if (allowedModeFlags.has(flag)) {
      if (flag === "-c" || flag === "--comment") {
        sawCommentMode = true;
      }
      if (flag === "-r" || flag === "--request-changes") {
        sawRequestChangesMode = true;
      }
      continue;
    }

    if (!allowedFlagsWithValue.has(flag)) {
      return `"gh ${key} ${arg}" is not allowed — only --comment/--request-changes with --body are permitted`;
    }

    if (flag === "-b" || flag === "--body") {
      hasBody = true;
    }

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      i += 1;
    }
  }

  if (!sawCommentMode && !sawRequestChangesMode) {
    return '"gh pr review" requires exactly one of --comment or --request-changes';
  }

  if (sawCommentMode && sawRequestChangesMode) {
    return '"gh pr review" requires exactly one of --comment or --request-changes';
  }

  if (!hasBody) {
    return '"gh pr review" requires --body';
  }

  return validateOptionalNumericSelector(key, selectors, "PR");
}
