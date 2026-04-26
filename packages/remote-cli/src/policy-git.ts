/**
 * git policy — explicit allowlist of Thor-supported workflows.
 *
 * This module intentionally supports a small set of command shapes. Anything
 * outside that allowlist is denied with a pointer to the `using-git` skill,
 * which is the user-facing documentation for the supported surface.
 */

import { booleanFlagCount, scanPolicyArgs, valueFlagValues } from "./policy-args.js";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize as normalizePosix } from "node:path/posix";

const DIGITS_ONLY = /^\d+$/;

interface ResolvedGitArgsSuccess {
  args: string[];
}
interface ResolvedGitArgsFailure {
  error: string;
}
export type ResolvedGitArgs = ResolvedGitArgsSuccess | ResolvedGitArgsFailure;

const WORKTREE_ROOT = "/workspace/worktrees";
const WORKTREE_PREFIX = `${WORKTREE_ROOT}/`;
const USING_GIT_HINT = "Load skill using-git for the supported command patterns.";

const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "shortlog",
  "merge-base",
  "branch",
  "rev-parse",
  "remote",
  "fetch",
  "ls-files",
  "ls-remote",
  "restore",
  "show-ref",
  "add",
  "commit",
  "worktree",
  "push",
  "blame",
  "reflog",
  "grep",
  "for-each-ref",
  "cat-file",
  "name-rev",
  "describe",
  "tag",
  "stash",
]);

const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

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
    case "shortlog":
    case "ls-files":
    case "show-ref":
    case "blame":
    case "reflog":
    case "grep":
    case "for-each-ref":
    case "cat-file":
    case "name-rev":
    case "describe":
    case "rev-parse":
      return { args: [...args] };
    case "merge-base":
      return wrap(validateMergeBase(args), args);
    case "branch":
      return wrap(validateBranch(args), args);
    case "remote":
      return wrap(validateRemote(args), args);
    case "fetch":
      return wrap(validateFetch(args), args);
    case "ls-remote":
      return wrap(validateLsRemote(args), args);
    case "tag":
      return wrap(validateTag(args), args);
    case "stash":
      return wrap(validateStash(args), args);
    case "restore":
      return wrap(validateRestore(args), args);
    case "add":
      return wrap(validateAdd(args), args);
    case "commit":
      return wrap(validateCommit(args), args);
    case "worktree":
      return wrap(validateWorktree(args), args);
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
  // Plain: `merge-base <left> <right>`.
  if (args.length === 3 && !args[1].startsWith("-") && !args[2].startsWith("-")) {
    return null;
  }
  // `merge-base --is-ancestor <left> <right>` — exits 0/1 without output.
  if (
    args.length === 4 &&
    args[1] === "--is-ancestor" &&
    !args[2].startsWith("-") &&
    !args[3].startsWith("-")
  ) {
    return null;
  }
  // `merge-base --fork-point <ref> [<commit>]`.
  if (
    (args.length === 3 || args.length === 4) &&
    args[1] === "--fork-point" &&
    args.slice(2).every((a) => !a.startsWith("-"))
  ) {
    return null;
  }
  return denyMessage("git merge-base");
}

function validateBranch(args: string[]): string | null {
  if (matchesExactArgs(args, ["branch", "--show-current"])) {
    return null;
  }

  const parsed = scanPolicyArgs(args, 1, [
    { name: "all", kind: "boolean", aliases: ["-a", "--all"] },
    { name: "list", kind: "boolean", aliases: ["--list"] },
  ]);
  if (!parsed) {
    return denyMessage("git branch");
  }

  const allCount = booleanFlagCount(parsed, "all");
  const listCount = booleanFlagCount(parsed, "list");
  if (allCount > 1 || listCount > 1 || parsed.positionals.length > 1) {
    return denyMessage("git branch");
  }

  if (listCount === 0) {
    return parsed.positionals.length === 0 && allCount === 1 ? null : denyMessage("git branch");
  }

  return null;
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
  if (args.length < 2) {
    return denyMessage("git fetch");
  }

  const parsed = scanPolicyArgs(args, 1, [
    { name: "prune", kind: "boolean", aliases: ["--prune", "-p"] },
    { name: "tags", kind: "boolean", aliases: ["--tags", "-t"] },
    { name: "no-tags", kind: "boolean", aliases: ["--no-tags"] },
    { name: "all", kind: "boolean", aliases: ["--all"] },
    { name: "depth", kind: "value", aliases: ["--depth"] },
  ]);
  if (!parsed) return denyMessage("git fetch");

  if (booleanFlagCount(parsed, "tags") > 0 && booleanFlagCount(parsed, "no-tags") > 0) {
    return denyMessage("git fetch");
  }

  const depths = valueFlagValues(parsed, "depth");
  if (depths.length > 1 || depths.some((d) => !DIGITS_ONLY.test(d) || d === "0")) {
    return denyMessage("git fetch");
  }

  // `--all` fetches every configured remote. Accept it standalone (no positional
  // remote), and deny the combination `--all origin ...` which Git already rejects.
  if (booleanFlagCount(parsed, "all") > 0) {
    return parsed.positionals.length === 0 ? null : denyMessage("git fetch");
  }

  // Otherwise: first positional must be `origin`; remaining positionals are refspecs.
  if (parsed.positionals.length === 0 || parsed.positionals[0] !== "origin") {
    return denyMessage("git fetch");
  }

  return null;
}

function validateRestore(args: string[]): string | null {
  // Approved flag pool before the `--` separator: at most one `--source[=<tree>]`
  // and any number of `--staged` / `-S` (a simple boolean toggle).
  let i = 1;
  let sawSource = false;

  while (i < args.length && args[i] !== "--") {
    const arg = args[i];
    if (arg === "--staged" || arg === "-S") {
      i += 1;
      continue;
    }
    if (arg === "--source") {
      if (sawSource || i + 1 >= args.length || args[i + 1].length === 0) {
        return denyMessage("git restore");
      }
      sawSource = true;
      i += 2;
      continue;
    }
    if (arg.startsWith("--source=")) {
      if (sawSource || arg.length <= "--source=".length) {
        return denyMessage("git restore");
      }
      sawSource = true;
      i += 1;
      continue;
    }
    return denyMessage("git restore");
  }

  if (i >= args.length || args[i] !== "--" || i + 1 >= args.length) {
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
  // Supported shapes (exactly one body source):
  //   `git commit -m <msg> [-m <msg>...]`     — one or more -m messages
  //   `git commit -F <path>` / `--file=<path>` — message from a file
  // The two forms are mutually exclusive. No other flags are accepted.
  const parsed = scanPolicyArgs(args, 1, [
    { name: "message", kind: "value", aliases: ["-m", "--message"] },
    { name: "file", kind: "value", aliases: ["-F", "--file"] },
  ]);
  if (!parsed || parsed.positionals.length > 0) return denyMessage("git commit");

  const messages = valueFlagValues(parsed, "message");
  const files = valueFlagValues(parsed, "file");

  if (messages.length > 0 && files.length > 0) return denyMessage("git commit");
  if (files.length > 1) return denyMessage("git commit");
  if (messages.length === 0 && files.length === 0) return denyMessage("git commit");

  return null;
}

function validateWorktree(args: string[]): string | null {
  const sub = args[1];
  if (sub === "add") return validateWorktreeAdd(args);
  if (sub === "list") return validateWorktreeList(args);
  if (sub === "remove") return validateWorktreeRemove(args);
  if (sub === "prune") return validateWorktreePrune(args);
  return denyMessage("git worktree");
}

function validateWorktreeList(args: string[]): string | null {
  // `git worktree list [--porcelain]` — read-only.
  if (args.length === 2) return null;
  if (args.length === 3 && args[2] === "--porcelain") return null;
  return denyMessage("git worktree list");
}

function validateWorktreeRemove(args: string[]): string | null {
  // `git worktree remove <path>` — path must be under /workspace/worktrees/.
  // --force is denied: callers should handle the "has uncommitted changes" case
  // explicitly rather than nuke blindly.
  if (args.length !== 3 || args[2].startsWith("-") || !isAbsolute(args[2])) {
    return denyMessage("git worktree remove");
  }
  const realPath = realpathOrNull(args[2]);
  if (!realPath || !realPath.startsWith(WORKTREE_PREFIX)) {
    return denyMessage("git worktree remove");
  }
  return null;
}

function validateWorktreePrune(args: string[]): string | null {
  // `git worktree prune [--dry-run]` — removes admin entries for gone worktrees.
  if (args.length === 2) return null;
  if (args.length === 3 && (args[2] === "--dry-run" || args[2] === "-n")) return null;
  return denyMessage("git worktree prune");
}

function validateWorktreeAdd(args: string[]): string | null {
  // Two supported shapes:
  //   `git worktree add -b <new-branch> <path> [<start-point>]` — create branch
  //   `git worktree add <path> <existing-branch>`                — check out existing
  // In both cases:
  //   * the path lives under /workspace/worktrees/
  //   * the path ends with the branch name (corr-key routing relies on this:
  //     the branch is inferred from the worktree path).
  if (args.length < 4 || args.length > 6) {
    return denyMessage("git worktree add");
  }

  const parsed = scanPolicyArgs(args, 2, [{ name: "branch", kind: "value", aliases: ["-b"] }]);
  if (!parsed) {
    return denyMessage("git worktree add");
  }

  const branchFlag = valueFlagValues(parsed, "branch");
  let branch: string;
  let path: string;

  if (branchFlag.length === 1) {
    // -b form: positionals are [path] or [path, start-point].
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
      return denyMessage("git worktree add");
    }
    branch = branchFlag[0];
    path = parsed.positionals[0];
  } else if (branchFlag.length === 0) {
    // No -b: positionals are [path, existing-branch].
    if (parsed.positionals.length !== 2) {
      return denyMessage("git worktree add");
    }
    path = parsed.positionals[0];
    branch = parsed.positionals[1];
  } else {
    return denyMessage("git worktree add");
  }

  if (!branch || branch.startsWith("-")) {
    return denyMessage("git worktree add");
  }

  const normalizedPath = normalizeWorktreeAddPath(path);
  if (!normalizedPath) {
    return denyMessage("git worktree add");
  }
  if (!normalizedPath.endsWith("/" + branch)) {
    return denyMessage("git worktree add");
  }

  return null;
}

function normalizeWorktreeAddPath(path: string): string | null {
  if (!isAbsolute(path)) return null;
  const normalized = normalizePosix(path);
  return normalized.startsWith(WORKTREE_PREFIX) ? normalized : null;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function validatePush(args: string[]): string | null {
  const parsed = scanPolicyArgs(args, 1, [
    { name: "dry-run", kind: "boolean", aliases: ["--dry-run"] },
    { name: "upstream", kind: "boolean", aliases: ["-u", "--set-upstream"] },
  ]);
  if (!parsed) {
    return denyMessage("git push");
  }

  if (
    booleanFlagCount(parsed, "dry-run") > 1 ||
    booleanFlagCount(parsed, "upstream") > 1 ||
    parsed.positionals.length !== 2 ||
    parsed.positionals[0] !== "origin"
  ) {
    return denyMessage("git push");
  }

  return validatePushRefspec(parsed.positionals[1]);
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

function validateLsRemote(args: string[]): string | null {
  // `git ls-remote [<flags>] origin [<ref-pattern>...]`. Network call, so the
  // remote must be `origin` — matches the `validateFetch` restriction.
  let sawRepo = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) continue;
    if (!sawRepo) {
      if (arg !== "origin") return denyMessage("git ls-remote");
      sawRepo = true;
      continue;
    }
    // Subsequent positionals are ref patterns; no further validation.
  }
  return sawRepo ? null : denyMessage("git ls-remote");
}

function validateTag(args: string[]): string | null {
  // List-only. `-l`/`--list` is required before any positional pattern —
  // without it, `git tag <name>` creates a tag at HEAD.
  const listMode = args.includes("-l") || args.includes("--list");
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      if (!listMode) return denyMessage("git tag");
      continue;
    }
    if (arg === "-l" || arg === "--list" || arg === "-n" || /^-n\d+$/.test(arg)) continue;
    return denyMessage("git tag");
  }
  return null;
}

function validateStash(args: string[]): string | null {
  // Read-only only: `git stash list [...]` and `git stash show [...]`.
  // Bare `git stash` defaults to `stash push`, so we require an explicit subcommand.
  if (args.length < 2) return denyMessage("git stash");
  const sub = args[1];
  if (sub === "list" || sub === "show") return null;
  return denyMessage("git stash");
}

function matchesExactArgs(args: string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, idx) => arg === expected[idx]);
}
