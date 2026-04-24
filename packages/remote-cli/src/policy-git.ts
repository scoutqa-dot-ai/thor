/**
 * git policy — explicit allowlist of Thor-supported workflows.
 *
 * This module intentionally supports a small set of command shapes. Anything
 * outside that allowlist is denied with a pointer to the `using-git` skill,
 * which is the user-facing documentation for the supported surface.
 */

interface ResolvedGitArgsSuccess {
  args: string[];
}
interface ResolvedGitArgsFailure {
  error: string;
}
export type ResolvedGitArgs = ResolvedGitArgsSuccess | ResolvedGitArgsFailure;

const WORKTREE_PREFIX = "/workspace/worktrees/";
const USING_GIT_HINT = "Load skill using-git for the supported command patterns.";

const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "merge-base",
  "branch",
  "remote",
  "fetch",
  "restore",
  "add",
  "commit",
  "worktree",
  "push",
]);

const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);
const ALLOWED_PUSH_FLAGS: ReadonlySet<string> = new Set(["--dry-run", "-u", "--set-upstream"]);

export function resolveGitArgs(args: string[], _cwd?: string): ResolvedGitArgs {
  if (!Array.isArray(args) || args.length === 0) {
    return { error: "args must be a non-empty array" };
  }

  const first = args[0];

  if (first === "--version") {
    return args.length === 1 ? { args: [...args] } : deny("git --version");
  }

  if (first.startsWith("-")) {
    return deny(`git ${first}`);
  }

  if (first === "checkout" || first === "switch") {
    return deny(`git ${first}`);
  }

  if (!ALLOWED_GIT_SUBCOMMANDS.has(first)) {
    return deny(`git ${first}`);
  }

  switch (first) {
    case "status":
    case "log":
    case "diff":
    case "show":
      return { args: [...args] };
    case "merge-base":
      return wrap(validateMergeBase(args), args);
    case "branch":
      return wrap(validateBranch(args), args);
    case "remote":
      return wrap(validateRemote(args), args);
    case "fetch":
      return wrap(validateFetch(args), args);
    case "restore":
      return wrap(validateRestore(args), args);
    case "add":
      return wrap(validateAdd(args), args);
    case "commit":
      return wrap(validateCommit(args), args);
    case "worktree":
      return wrap(validateWorktreeAdd(args), args);
    case "push":
      return wrap(validatePush(args), args);
    default:
      return deny(`git ${first}`);
  }
}

export function validateGitArgs(args: string[], cwd?: string): string | null {
  const result = resolveGitArgs(args, cwd);
  return "error" in result ? result.error : null;
}

function wrap(err: string | null, args: string[]): ResolvedGitArgs {
  return err ? { error: err } : { args: [...args] };
}

function deny(command: string): ResolvedGitArgsFailure {
  return { error: denyMessage(command) };
}

function denyMessage(command: string): string {
  return `"${command}" is not allowed. ${USING_GIT_HINT}`;
}

function validateMergeBase(args: string[]): string | null {
  if (args.length !== 3 || args[1].startsWith("-") || args[2].startsWith("-")) {
    return denyMessage("git merge-base");
  }
  return null;
}

function validateBranch(args: string[]): string | null {
  if (
    matchesExactArgs(args, ["branch", "--show-current"]) ||
    matchesExactArgs(args, ["branch", "-a"]) ||
    matchesExactArgs(args, ["branch", "--all"])
  ) {
    return null;
  }

  return denyMessage("git branch");
}

function validateRemote(args: string[]): string | null {
  if (
    matchesExactArgs(args, ["remote"]) ||
    matchesExactArgs(args, ["remote", "-v"]) ||
    matchesExactArgs(args, ["remote", "--verbose"]) ||
    matchesExactArgs(args, ["remote", "show", "origin"]) ||
    matchesExactArgs(args, ["remote", "get-url", "origin"])
  ) {
    return null;
  }

  return denyMessage("git remote");
}

function validateFetch(args: string[]): string | null {
  if (args.length < 2 || args[1] !== "origin") {
    return denyMessage("git fetch");
  }

  for (let i = 2; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      return denyMessage("git fetch");
    }
  }

  return null;
}

function validateRestore(args: string[]): string | null {
  let i = 1;

  if (i < args.length && args[i] === "--source") {
    if (i + 1 >= args.length || args[i + 1].length === 0) {
      return denyMessage("git restore");
    }
    i += 2;
  } else if (i < args.length && args[i].startsWith("--source=")) {
    if (args[i].length <= "--source=".length) {
      return denyMessage("git restore");
    }
    i += 1;
  }

  if (i >= args.length || args[i] !== "--") {
    return denyMessage("git restore");
  }

  if (i + 1 >= args.length) {
    return denyMessage("git restore");
  }

  return null;
}

function validateAdd(args: string[]): string | null {
  if (matchesExactArgs(args, ["add", "-A"])) {
    return null;
  }

  if (args.length < 2) {
    return denyMessage("git add");
  }

  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      return denyMessage("git add");
    }
  }

  return null;
}

function validateCommit(args: string[]): string | null {
  if (args.length === 3 && args[1] === "-m") {
    return null;
  }

  return denyMessage("git commit");
}

function validateWorktreeAdd(args: string[]): string | null {
  if (args[1] !== "add" || args[2] !== "-b" || (args.length !== 5 && args.length !== 6)) {
    return denyMessage("git worktree add");
  }

  const branch = args[3];
  const path = args[4];

  if (!branch || branch.startsWith("-")) {
    return denyMessage("git worktree add");
  }

  const normalizedPath = normalizePath(path);
  if (!normalizedPath.startsWith(WORKTREE_PREFIX)) {
    return denyMessage("git worktree add");
  }

  if (args.length === 6 && args[5].startsWith("-")) {
    return denyMessage("git worktree add");
  }

  return null;
}

function validatePush(args: string[]): string | null {
  let i = 1;
  let sawDryRun = false;
  let sawUpstream = false;

  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i];
    if (!ALLOWED_PUSH_FLAGS.has(arg)) {
      return denyMessage("git push");
    }
    if (arg === "--dry-run") {
      if (sawDryRun) return denyMessage("git push");
      sawDryRun = true;
    } else {
      if (sawUpstream) return denyMessage("git push");
      sawUpstream = true;
    }
    i += 1;
  }

  if (args.length - i !== 2 || args[i] !== "origin") {
    return denyMessage("git push");
  }

  return validatePushRefspec(args[i + 1]);
}

function validatePushRefspec(refspec: string): string | null {
  const prefix = "HEAD:refs/heads/";
  if (!refspec.startsWith(prefix)) {
    return denyMessage("git push");
  }

  const branch = refspec.slice(prefix.length);
  if (!branch || branch.includes(":") || PROTECTED_PUSH_BRANCHES.has(branch)) {
    return denyMessage("git push");
  }

  return null;
}

function matchesExactArgs(args: string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, idx) => arg === expected[idx]);
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}
