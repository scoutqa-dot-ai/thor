import { execFileSync } from "node:child_process";

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

interface ResolvedGitArgsSuccess {
  args: string[];
}

interface ResolvedGitArgsFailure {
  error: string;
}

export type ResolvedGitArgs = ResolvedGitArgsSuccess | ResolvedGitArgsFailure;

interface ResolvedImplicitPushTarget {
  remote: "origin";
  refspec: string;
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
  "config",
  "check-ignore",
  "symbolic-ref",
  "check-ref-format",
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

const NO_PAGER_SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "diff-tree",
  "show",
  "show-branch",
  "show-ref",
  "rev-list",
  "rev-parse",
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
  "config",
  "check-ignore",
  "symbolic-ref",
  "check-ref-format",
  "remote",
]);

export function resolveGitArgs(args: string[], cwd?: string): ResolvedGitArgs {
  if (!Array.isArray(args) || args.length === 0) {
    return { error: "args must be a non-empty array" };
  }

  const first = args[0];
  if (first === "--version") {
    return args.length === 1
      ? { args: [...args] }
      : { error: '"git --version" does not accept additional arguments' };
  }

  if (first === "--no-pager") {
    return resolveGitNoPagerArgs(args.slice(1), cwd, args);
  }

  if (first.startsWith("-")) {
    return {
      error: `"git ${first}" is not allowed — leading flags are not permitted; start with a bare subcommand`,
    };
  }

  const subcommand = first.toLowerCase();
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === "checkout") {
      const error = validateGitCheckoutRestore(args);
      return error ? { error } : { args: [...args] };
    }
    if (subcommand === "switch") {
      return {
        error: `"git ${subcommand}" is not allowed — use 'git worktree add <path> <ref>' to work on another branch without leaving this worktree`,
      };
    }
    return { error: `"git ${subcommand}" is not allowed` };
  }

  // Restrict worktree add paths to /workspace/worktrees/
  if (subcommand === "worktree") {
    const error = validateGitWorktree(args);
    return error ? { error } : { args: [...args] };
  }

  // Restrict remote to read-only sub-subcommands
  if (subcommand === "remote") {
    const error = validateGitRemote(args);
    return error ? { error } : { args: [...args] };
  }

  // Restrict push to origin only (block pushing to arbitrary remotes/URLs)
  if (subcommand === "push") {
    return resolveGitPushArgs(args, cwd);
  }

  if (subcommand === "config") {
    const error = validateGitConfig(args);
    return error ? { error } : { args: [...args] };
  }

  if (subcommand === "check-ignore") {
    const error = validateGitCheckIgnore(args);
    return error ? { error } : { args: [...args] };
  }

  if (subcommand === "symbolic-ref") {
    const error = validateGitSymbolicRef(args);
    return error ? { error } : { args: [...args] };
  }

  return { args: [...args] };
}

export function validateGitArgs(args: string[], cwd?: string): string | null {
  const resolved = resolveGitArgs(args, cwd);
  return "error" in resolved ? resolved.error : null;
}

const WORKTREE_PREFIX = "/workspace/worktrees/";

function resolveGitNoPagerArgs(
  args: string[],
  cwd: string | undefined,
  originalArgs: string[],
): ResolvedGitArgs {
  if (args.length === 0) {
    return { error: '"git --no-pager" requires a subcommand' };
  }

  const subcommand = args[0].toLowerCase();
  if (!NO_PAGER_SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      error: `"git --no-pager ${subcommand}" is not allowed — only read-only commands may use --no-pager`,
    };
  }

  const resolved = resolveGitArgs(args, cwd);
  return "error" in resolved ? resolved : { args: [originalArgs[0], ...resolved.args] };
}

const RESTORE_CHECKOUT_HINT =
  "\"git checkout\" is not allowed — use 'git worktree add <path> <ref>' to work on another branch without leaving this worktree";

const CHECKOUT_PATHSPEC_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".dart",
  ".xml",
  ".yaml",
  ".yml",
  ".kt",
  ".kts",
  ".java",
  ".py",
  ".go",
  ".sh",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".txt",
  ".lock",
  ".toml",
  ".gradle",
  ".properties",
  ".prisma",
];

function validateGitCheckoutRestore(args: string[]): string | null {
  const beforeSeparator: string[] = [];
  const afterSeparator: string[] = [];
  let sawSeparator = false;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      if (sawSeparator) {
        return RESTORE_CHECKOUT_HINT;
      }
      sawSeparator = true;
      continue;
    }

    if (arg === "--ours" || arg === "--theirs") {
      if (sawSeparator) {
        return RESTORE_CHECKOUT_HINT;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      return RESTORE_CHECKOUT_HINT;
    }

    if (sawSeparator) {
      afterSeparator.push(arg);
    } else {
      beforeSeparator.push(arg);
    }
  }

  if (sawSeparator) {
    if (afterSeparator.length === 0 || beforeSeparator.length > 1) {
      return RESTORE_CHECKOUT_HINT;
    }
    return afterSeparator.every(looksLikeCheckoutPathspec) ? null : RESTORE_CHECKOUT_HINT;
  }

  if (beforeSeparator.length === 0) {
    return RESTORE_CHECKOUT_HINT;
  }

  return beforeSeparator.every(looksLikeCheckoutPathspec) ? null : RESTORE_CHECKOUT_HINT;
}

function looksLikeCheckoutPathspec(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value === "." || value === "./." || value.endsWith("/")) {
    return true;
  }

  if (value.startsWith(":(") || value.includes("*") || value.includes("?")) {
    return true;
  }

  const normalized = value.toLowerCase();
  if (normalized === ".gitignore" || normalized === ".metadata") {
    return true;
  }

  const parts = normalized.split("/");
  const last = parts[parts.length - 1];
  return CHECKOUT_PATHSPEC_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

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

// ── git config policy ──────────────────────────────────────────────────────

const ALLOWED_GIT_CONFIG_READ_MODES: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
]);

function validateGitConfig(args: string[]): string | null {
  let i = 1;
  let mode: string | undefined;

  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      break;
    }

    if (arg === "--show-origin") {
      i += 1;
      continue;
    }

    if (ALLOWED_GIT_CONFIG_READ_MODES.has(arg)) {
      mode = arg;
      i += 1;
      break;
    }

    return `"git config ${arg}" is not allowed — only read-only --get lookups are permitted`;
  }

  if (!mode) {
    return '"git config" is not allowed — only read-only --get lookups are permitted';
  }

  if (i >= args.length) {
    return `"git config ${mode}" requires a key or pattern`;
  }

  for (; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      return `"git config ${args[i]}" is not allowed — only read-only --get lookups are permitted`;
    }
  }

  return null;
}

// ── git check-ignore policy ────────────────────────────────────────────────

const ALLOWED_GIT_CHECK_IGNORE_FLAGS: ReadonlySet<string> = new Set([
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-n",
  "--non-matching",
]);

function validateGitCheckIgnore(args: string[]): string | null {
  let sawPath = false;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!ALLOWED_GIT_CHECK_IGNORE_FLAGS.has(arg)) {
        return `"git check-ignore ${arg}" is not allowed — only direct path lookups are permitted`;
      }
      continue;
    }

    sawPath = true;
  }

  return sawPath ? null : '"git check-ignore" requires at least one path';
}

// ── git symbolic-ref policy ────────────────────────────────────────────────

const ALLOWED_GIT_SYMBOLIC_REF_FLAGS: ReadonlySet<string> = new Set(["--short", "-q", "--quiet"]);

function validateGitSymbolicRef(args: string[]): string | null {
  const refs: string[] = [];

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!ALLOWED_GIT_SYMBOLIC_REF_FLAGS.has(arg)) {
        return `"git symbolic-ref ${arg}" is not allowed — only read-only ref lookups are permitted`;
      }
      continue;
    }

    refs.push(arg);
  }

  return refs.length === 1 ? null : '"git symbolic-ref" only allows reading a single symbolic ref';
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

function resolveGitPushArgs(args: string[], cwd?: string): ResolvedGitArgs {
  const pushIdx = args.indexOf("push");

  let i = pushIdx + 1;
  const flags: string[] = [];
  let sawRemote = false;
  let remote: string | undefined;
  const refspecs: string[] = [];
  while (i < args.length) {
    const arg = args[i];

    if (ALLOWED_PUSH_FLAGS.has(arg)) {
      flags.push(arg);
      i += 1;
    } else if (arg.startsWith("-")) {
      return { error: `"git push ${arg}" is not allowed — unrecognized flag` };
    } else if (!sawRemote) {
      // First positional arg = remote
      sawRemote = true;
      remote = arg;
      i += 1;
    } else {
      refspecs.push(arg);
      i += 1;
    }
  }

  if (!sawRemote) {
    const implicit = resolveImplicitPushTarget(cwd, "git push");
    if ("error" in implicit) return implicit;
    remote = implicit.remote;
    refspecs.push(implicit.refspec);
  } else if (remote !== "origin") {
    return { error: `"git push ${remote}" is not allowed — only pushing to "origin" is permitted` };
  }

  if (refspecs.length === 0) {
    const implicit = resolveImplicitPushTarget(cwd, "git push origin");
    if ("error" in implicit) return implicit;
    refspecs.push(implicit.refspec);
  }

  for (const refspec of refspecs) {
    const refspecError = validatePushRefspec(refspec);
    if (refspecError) return { error: refspecError };
  }

  return { args: ["push", ...flags, remote ?? "origin", ...refspecs] };
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

function resolveImplicitPushTarget(
  cwd: string | undefined,
  commandLabel: "git push" | "git push origin",
): ResolvedGitArgsFailure | ResolvedImplicitPushTarget {
  if (!cwd) {
    return {
      error:
        commandLabel === "git push"
          ? '"git push" is not allowed — must explicitly specify remote "origin"'
          : '"git push origin" is not allowed — must include an explicit branch or refspec',
    };
  }

  const currentBranch = readGitOutput(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    `"${commandLabel}" is not allowed — implicit push requires a checked-out branch`,
  );
  if ("error" in currentBranch) return currentBranch;

  const remote = readGitOutput(
    cwd,
    ["config", "--local", "--get", `branch.${currentBranch.value}.remote`],
    `"${commandLabel}" is not allowed — current branch must have an upstream on "origin" or specify an explicit target`,
  );
  if ("error" in remote) return remote;

  if (remote.value !== "origin") {
    return {
      error: `"${commandLabel}" is not allowed — current branch upstream must use "origin"`,
    };
  }

  const mergeRef = readGitOutput(
    cwd,
    ["config", "--local", "--get", `branch.${currentBranch.value}.merge`],
    `"${commandLabel}" is not allowed — current branch must have an upstream branch or specify an explicit target`,
  );
  if ("error" in mergeRef) return mergeRef;

  if (!mergeRef.value.startsWith("refs/heads/") || mergeRef.value.length <= "refs/heads/".length) {
    return {
      error: `"${commandLabel}" is not allowed — upstream branch must resolve to "refs/heads/<branch>"`,
    };
  }

  return {
    remote: "origin",
    refspec: `HEAD:${mergeRef.value}`,
  };
}

function readGitOutput(
  cwd: string,
  gitArgs: string[],
  failureMessage: string,
): { value: string } | ResolvedGitArgsFailure {
  try {
    const value = execFileSync("/usr/bin/git", gitArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();

    return value ? { value } : { error: failureMessage };
  } catch {
    return { error: failureMessage };
  }
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
  "auth status",
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
  "run watch",
  "search issues",
  "search prs",
  "search code",
  "search repos",
  "workflow list",
  "workflow view",
  "label list",
  "release list",
  "release view",
  "release download",
]);

export function validateGhArgs(args: string[], cwd?: string): string | null {
  if (!Array.isArray(args)) {
    return "args must be an array";
  }

  if (args.length === 0) {
    return null;
  }

  if (args[0] === "--version") {
    return args.length === 1 ? null : '"gh --version" does not accept additional arguments';
  }

  if (isGhHelpRequest(args)) {
    return validateGhHelpArgs(args);
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
    return validateGhAppendOnlyCommentArgs(args, key, cwd);
  }

  if (key === "pr review") {
    return validateGhPrReviewArgs(args, cwd);
  }

  return null;
}

function isGhHelpRequest(args: string[]): boolean {
  return args[0] === "help" || args.includes("--help") || args.includes("-h");
}

function validateGhHelpArgs(args: string[]): string | null {
  const topic = resolveGhHelpTopic(args);
  if (topic === "api") {
    return '"gh api --help" is not allowed — gh api remains blocked';
  }

  return null;
}

function resolveGhHelpTopic(args: string[]): string | undefined {
  if (args[0] === "help") {
    return args[1];
  }

  return args[0];
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

    let value: string | undefined;

    if (eqIdx < 0) {
      if (i + 1 >= args.length) {
        return `"gh ${key} ${flag}" requires a value`;
      }
      value = args[i + 1];
      i += 1;
    } else {
      value = arg.slice(eqIdx + 1);
    }

    if ((flag === "-H" || flag === "--head") && !isValidLocalBranchSelector(value ?? "")) {
      return `"gh ${key} ${flag}" is not allowed — --head must be a branch in the current repo`;
    }
  }

  if (!hasTitle || !hasBody) {
    return '"gh pr create" requires both --title and --body';
  }

  return null;
}

function validateGhAppendOnlyCommentArgs(args: string[], key: string, cwd?: string): string | null {
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
    return validateOptionalPrSelector(key, selectors, cwd);
  }

  return validateRequiredIssueSelector(key, selectors, cwd);
}

function validateOptionalPrSelector(key: string, selectors: string[], cwd?: string): string | null {
  if (selectors.length > 1) {
    return `"gh ${key}" allows at most one positional PR selector`;
  }

  if (selectors.length === 0) {
    return null;
  }

  return validatePrSelector(key, selectors[0], cwd);
}

function validateRequiredIssueSelector(
  key: string,
  selectors: string[],
  cwd?: string,
): string | null {
  if (selectors.length !== 1) {
    return `"gh ${key}" requires exactly one positional issue selector`;
  }

  return validateIssueSelector(key, selectors[0], cwd);
}

function validatePrSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) {
    return null;
  }

  if (looksLikeHttpsUrl(selector)) {
    return validateCurrentRepoUrlSelector(key, selector, "pull", cwd);
  }

  if (!isValidLocalBranchSelector(selector)) {
    return `"gh ${key}" positional selector must be a numeric PR number, current-repo PR URL, or branch name`;
  }

  return null;
}

function validateIssueSelector(key: string, selector: string, cwd?: string): string | null {
  if (/^\d+$/.test(selector)) {
    return null;
  }

  if (looksLikeHttpsUrl(selector)) {
    return validateCurrentRepoUrlSelector(key, selector, "issues", cwd);
  }

  return `"gh ${key}" positional selector must be a numeric issue number or current-repo issue URL`;
}

function validateCurrentRepoUrlSelector(
  key: string,
  selector: string,
  resourceType: "pull" | "issues",
  cwd?: string,
): string | null {
  const target = parseGitHubResourceUrl(selector, resourceType);
  if (!target) {
    const resourceName = resourceType === "pull" ? "PR" : "issue";
    return `"gh ${key}" positional selector must be a valid ${resourceName} URL`;
  }

  const currentRepo = resolveCurrentGitHubRepo(cwd);
  if (!currentRepo) {
    return `"gh ${key}" URL selectors require a resolvable origin remote for the current repo`;
  }

  if (
    target.host !== currentRepo.host ||
    target.owner !== currentRepo.owner ||
    target.repo !== currentRepo.repo
  ) {
    return `"gh ${key}" URL selector must target the current repo`;
  }

  return null;
}

function looksLikeHttpsUrl(value: string): boolean {
  return value.startsWith("https://");
}

function isValidLocalBranchSelector(selector: string): boolean {
  if (!selector || selector.includes(":") || selector.includes("#")) {
    return false;
  }

  try {
    execFileSync("/usr/bin/git", ["check-ref-format", "--branch", selector], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

interface GitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

function resolveCurrentGitHubRepo(cwd?: string): GitHubRepoRef | undefined {
  if (!cwd) {
    return undefined;
  }

  try {
    const remoteUrl = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return parseGitHubRepoFromRemoteUrl(remoteUrl);
  } catch {
    return undefined;
  }
}

function parseGitHubRepoFromRemoteUrl(url: string): GitHubRepoRef | undefined {
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: normalizeRepoHost(sshMatch[1]),
      owner: normalizeRepoSegment(sshMatch[2]),
      repo: normalizeRepoSegment(sshMatch[3]),
    };
  }

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return undefined;
    }

    return {
      host: normalizeRepoHost(parsed.hostname),
      owner: normalizeRepoSegment(parts[0]),
      repo: normalizeRepoSegment(parts[1]),
    };
  } catch {
    return undefined;
  }
}

function parseGitHubResourceUrl(
  url: string,
  resourceType: "pull" | "issues",
): GitHubRepoRef | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return undefined;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 4) {
      return undefined;
    }

    const [owner, repo, resource, number] = parts;
    if (resource !== resourceType || !/^\d+$/.test(number)) {
      return undefined;
    }

    return {
      host: normalizeRepoHost(parsed.hostname),
      owner: normalizeRepoSegment(owner),
      repo: normalizeRepoSegment(repo),
    };
  } catch {
    return undefined;
  }
}

function normalizeRepoHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizeRepoSegment(value: string): string {
  return value
    .replace(/\.git$/i, "")
    .trim()
    .toLowerCase();
}

function validateGhPrReviewArgs(args: string[], cwd?: string): string | null {
  const key = "pr review";
  const allowedFlagsWithValue: ReadonlySet<string> = new Set(["-b", "--body"]);

  const allowedModeFlags: ReadonlySet<string> = new Set([
    "-c",
    "--comment",
    "-r",
    "--request-changes",
  ]);

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

  return validateOptionalPrSelector(key, selectors, cwd);
}
